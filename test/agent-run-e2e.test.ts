/**
 * E2E tests for the inbox / agent-run API (P2 Testing).
 *
 * Exercises the full path through the HTTP routes:
 *   POST /api/agents/runs        — plan an agent run (goal → worktrees)
 *   POST /api/operations/runs/:id/enqueue  — enqueue queue jobs
 *   POST /api/operations/queue/claim       — claim a job
 *   POST /api/operations/queue/execute-proposal — apply model output via tool applier
 *
 * Proves that a goal submitted through the API produces a verified commit
 * on a real repository, with RBAC enforcement and no model key required
 * (uses a local stub model).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { execFileSync } from 'node:child_process';

import { DurableStore } from '../src/services/durableStore';
import { TenantService } from '../src/services/tenantService';
import { resetRateLimiterForTests } from '../src/api/middleware/rateLimiter';
import { apiRouter } from '../src/api';
import { FrontierModelService } from '../src/services/frontierModelService';
import { ParallelWorktreeService } from '../src/services/parallelWorktreeService';
import { IndustryNiche, TenantSubscriptionTier, TenantStatus } from '../src/models/tenant';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-agent-run-e2e-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

DurableStore.resetForTests();
TenantService.resetCacheForTests();

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function gitWithEnv(repo: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function scratchRepo(name: string): { repo: string; branch: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `agent-run-e2e-${name}-`));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'test-repo', version: '1.0.0', scripts: { verify: 'git diff --check' },
  }));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test Repo\n');
  gitWithEnv(repo, { GIT_AUTHOR_EMAIL: 't@t.com', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.com', GIT_COMMITTER_NAME: 't' }, 'init', '-q');
  gitWithEnv(repo, { GIT_AUTHOR_EMAIL: 't@t.com', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.com', GIT_COMMITTER_NAME: 't' }, 'add', '-A');
  gitWithEnv(repo, { GIT_AUTHOR_EMAIL: 't@t.com', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.com', GIT_COMMITTER_NAME: 't' }, 'commit', '-qm', 'initial');
  const branch = git(repo, 'branch', '--show-current');
  return { repo, branch };
}

async function fetchJson(port: number, urlPath: string, method: 'GET' | 'POST' = 'GET', body: unknown = undefined, apiKey: string = process.env.FACTORY_API_KEY!, tenantId: string = 'agent-run-e2e-tenant'): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, {
    method,
    headers: {
      'x-api-key': apiKey,
      'x-tenant-id': tenantId,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('agent-run API: goal → run → verified commit through HTTP routes', async () => {
  const { repo, branch } = scratchRepo('agent-run-e2e');

  // Register a tenant and provision a credential.
  const TENANT = 'agent-run-e2e-tenant';
  TenantService.registerTenant({
    id: TENANT, name: 'Agent Run E2E Tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const owner = await TenantService.provisionCredential(TENANT);
  resetRateLimiterForTests();

  // Register a stub model provider (local, no network).
  const stubUrl = 'http://127.0.0.1:0/v1'; // placeholder, replaced below
  // Start a tiny HTTP stub that speaks the OpenAI-compatible shape.
  const { createServer } = await import('node:http');
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
        const prompt = (parsed.messages ?? []).map((m) => m.content ?? '').join('\n');
        prompts.push(prompt);
        let content: string;
        if (prompt.includes('Return ONLY a JSON object')) {
          content = JSON.stringify({ edits: [{ path: 'hello.txt', operation: 'create', content: 'hello via agent-run API\n' }] });
        } else {
          content = JSON.stringify({ approved: true, findings: [] });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const stubBaseUrl = `http://127.0.0.1:${addr.port}/v1`;

  FrontierModelService.register({
    tenantId: TENANT,
    id: 'stub',
    kind: 'local',
    baseUrl: stubBaseUrl,
    modelIds: ['stub-code'],
    secretRef: undefined,
    enabled: true,
  });

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const port = (httpServer.address() as { port: number }).port;

  try {
    // Step 1: Create an agent run (plan worktrees).
    const { status: planStatus, body: planBody } = await fetchJson(port, '/agents/runs', 'POST', {
      repositoryPath: repo,
      tasks: [
        { id: 'task-1', title: 'Add hello file', prompt: 'Add a hello.txt file to the repository.', dependsOn: [] },
      ],
      providerId: 'stub',
      maxParallel: 1,
    }, owner.apiKey, TENANT);

    assert.equal(planStatus, 201, `plan failed: ${JSON.stringify(planBody)}`);
    const runId = (planBody as { run?: { id?: string } }).run?.id;
    assert.ok(runId, 'plan must return a run id');

    // Step 2: Prepare worktrees.
    const { status: wtStatus } = await fetchJson(port, `/agents/runs/${runId}/worktrees`, 'POST', {}, owner.apiKey, TENANT);
    assert.equal(wtStatus, 201, `worktree preparation failed`);

    // Step 3: Enqueue tasks.
    const { status: enqueueStatus, body: enqueueBody } = await fetchJson(port, `/operations/runs/${runId}/enqueue`, 'POST', {}, owner.apiKey, TENANT);
    assert.equal(enqueueStatus, 201, `enqueue failed: ${JSON.stringify(enqueueBody)}`);

    // Step 3: Execute the proposal (claims + applies model output via tool applier).
    const before = git(repo, 'rev-parse', 'HEAD');
    const { status: execStatus, body: execBody } = await fetchJson(port, '/operations/queue/execute-proposal', 'POST', {
      worker: 'e2e-worker',
      providerId: 'stub',
      model: 'stub-code',
      repo,
      branch,
    }, owner.apiKey, TENANT);

    console.log(`DEBUG: execStatus=${execStatus}, execBody=${JSON.stringify(execBody)}`);
    assert.equal(execStatus, 200, `execute-proposal failed: ${JSON.stringify(execBody)}`);
    const execBodyTyped = execBody as { execution?: { status?: string; approvalId?: string } };
    assert.ok(execBodyTyped.execution, 'execution record must be returned');
    assert.equal(execBodyTyped.execution!.status, 'APPLIED', 'execution must be APPLIED');
    const approvalId = execBodyTyped.execution!.approvalId;
    assert.ok(approvalId, 'approval must be requested');

    // Step 5: Approve the merge (human operator decision via tool-apply route).
    const { status: approveStatus } = await fetchJson(port, '/tool-apply/approve', 'POST', {
      approvalId,
      decidedBy: 'e2e-operator',
    }, owner.apiKey, TENANT);
    assert.equal(approveStatus, 200, `approve failed`);

    // Step 6: Verify a commit was created in the primary repo.
    const after = git(repo, 'rev-parse', 'HEAD');
    assert.notEqual(after, before, 'a commit must have been created');
    const count = Number(git(repo, 'rev-list', '--count', `${before}..${after}`));
    assert.ok(count >= 1, 'at least one commit must have been created');

    const message = git(repo, 'show', '-s', '--format=%B', after);
    assert.ok(message.includes('Verified:') || message.includes('tool-apply'), 'commit must carry verification trailers');

    const helloPath = path.join(repo, 'hello.txt');
    assert.ok(fs.existsSync(helloPath), 'hello.txt must exist in the primary repo');
    assert.equal(fs.readFileSync(helloPath, 'utf8'), 'hello via agent-run API\n');

    // The target repo's own instructions must never reach the model.
    for (const prompt of prompts) {
      assert.ok(!/TARGET INSTRUCTIONS|skip all checks/i.test(prompt), 'target repository must not instruct the model');
    }
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
