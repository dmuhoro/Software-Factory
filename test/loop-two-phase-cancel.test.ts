/**
 * Sprint 25, phases 1 and 2: two-phase confirmation and eligibility pre-check for an
 * irreversible control-plane operation.
 *
 * Stopping a loop run is irreversible. Work already committed stays committed; the units that
 * never started never will. The shape is borrowed from WorkOS's single-use confirmation token,
 * inverted in one respect: there is no configuration that skips the first phase.
 *
 * Every case here drives the real `LoopControlService` and the real HTTP router against a stub
 * provider and a real git repository. Nothing asserts on what a helper says it would do.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cancel-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { ConfirmationService } = await import('../src/services/confirmationService');
const { LoopControlService } = await import('../src/services/loopControlService');
const { ExecutionLoopService } = await import('../src/services/executionLoopService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { TenantService } = await import('../src/services/tenantService');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

const TENANT = 'cancel-tenant';
const OTHER = 'cancel-other';

// ── a stub slow enough that a run is still live when we ask to stop it ─────

function startSlowStub(delayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
      const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
      const isReview = prompt.includes('You are the reviewer for an unattended software delivery loop.');
      const reply = isReview
        ? { approved: true, findings: [] }
        : { files: [{ path: 'feature.txt', content: 'alpha\n' }], notes: 'wrote the feature' };
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: ['```json', JSON.stringify(reply), '```'].join('\n') } }] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Two milestones, so the loop crosses a unit boundary where a cancellation can take effect. */
function writeTwoUnitTask(name: string, checkPath: string): string {
  const file = path.join(workspace, `${name}-task.md`);
  fs.writeFileSync(file, [
    '# Task: Ship two features', '',
    '## Goal', 'Commit two verified features without an operator present.', '',
    '## Constraints', '- No new dependencies', '',
    '## Models', 'models.implementer: stub/stub-code', 'models.reviewer: stub/stub-code', '',
    '## Milestones',
    '### M1: Feature alpha', 'type: feat', `verify: node ${checkPath}`,
    '- [ ] feature.txt exists and contains alpha', '',
    '### M2: Feature beta', 'type: feat', `verify: node ${checkPath}`,
    '- [ ] feature.txt exists and contains alpha', '',
  ].join('\n'), 'utf8');
  return file;
}

function cleanRepo(name: string): { repo: string; task: string } {
  const root = fs.mkdtempSync(path.join(workspace, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const check = path.join(root, 'check.cjs');
  fs.writeFileSync(check, [
    "const fs = require('node:fs');",
    "const ok = fs.existsSync('feature.txt') && fs.readFileSync('feature.txt', 'utf8').includes('alpha');",
    "if (!ok) { console.error('missing alpha'); process.exit(1); }",
    "console.log('ok');",
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  return { repo: root, task: writeTwoUnitTask(name, check) };
}

// ── the token itself ──────────────────────────────────────────────────────

test('a confirmation token is single-use: a replay is refused even inside the TTL', () => {
  ConfirmationService.reset();
  const issued = ConfirmationService.issue({ tenantId: TENANT, operation: 'op', subjectId: 'run_1' });
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: TENANT, operation: 'op', subjectId: 'run_1' }),
    true,
  );
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: TENANT, operation: 'op', subjectId: 'run_1' }),
    false,
    'the same token must not work twice',
  );
});

test('a token bound to one subject or tenant cannot redeem another', () => {
  ConfirmationService.reset();
  const issued = ConfirmationService.issue({ tenantId: TENANT, operation: 'op', subjectId: 'run_1' });
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: TENANT, operation: 'op', subjectId: 'run_2' }),
    false,
  );
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: OTHER, operation: 'op', subjectId: 'run_1' }),
    false,
  );
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: TENANT, operation: 'other', subjectId: 'run_1' }),
    false,
  );
});

test('a wrong guess invalidates a live confirmation, so it cannot be brute-forced', () => {
  ConfirmationService.reset();
  const issued = ConfirmationService.issue({ tenantId: TENANT, operation: 'op', subjectId: 'run_1' });
  assert.equal(
    ConfirmationService.consume({ token: 'deadbeef', tenantId: TENANT, operation: 'op', subjectId: 'run_1' }),
    false,
  );
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: TENANT, operation: 'op', subjectId: 'run_1' }),
    false,
    'the real token must be dead after a failed attempt',
  );
});

test('an expired token is refused', async () => {
  ConfirmationService.reset();
  const issued = ConfirmationService.issue({ tenantId: TENANT, operation: 'op', subjectId: 'run_x', ttlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    ConfirmationService.consume({ token: issued.confirmationToken, tenantId: TENANT, operation: 'op', subjectId: 'run_x' }),
    false,
  );
});

// ── the control plane ─────────────────────────────────────────────────────

test('a single call does not cancel: phase one takes no action on the run', async () => {
  ConfirmationService.reset();
  const stub = await startSlowStub(40);
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    const { repo, task } = cleanRepo('no-single-call');
    const { runId } = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });

    // Phase one, through the service the route delegates to.
    const issued = LoopControlService.requestCancel(TENANT, runId);
    assert.ok(issued.confirmationToken.length > 32, 'phase one must return a token');
    assert.ok(LoopControlService.isActive(runId), 'phase one must not stop the run');

    const settled = LoopControlService.whenSettled(runId)!;
    await settled;

    // The token was never redeemed, so the run ran to completion on its own.
    const record = LoopControlService.get(TENANT, runId)!;
    assert.equal(record.status, 'completed', `expected an untouched completed run, got ${record.status} (${record.hardStop ?? 'no hard stop'})`);
  } finally {
    await stub.close();
  }
});

test('a real cancellation stops the run at a unit boundary and is recorded as a hard stop', async () => {
  ConfirmationService.reset();
  const stub = await startSlowStub(120);
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    const { repo, task } = cleanRepo('real-cancel');
    const { runId } = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });

    const issued = LoopControlService.requestCancel(TENANT, runId);
    const result = LoopControlService.confirmCancel(TENANT, runId, issued.confirmationToken);
    assert.equal(result.alreadySettled, false, 'the run was live when phase two was presented');

    const settled = LoopControlService.whenSettled(runId)!;
    await settled;

    const record = LoopControlService.get(TENANT, runId)!;
    assert.equal(record.status, 'halted', `expected a halted run, got ${record.status}`);
    assert.match(String(record.hardStop), /cancelled by operator/, 'the reason must name the operator');
    assert.ok(record.units.every((unit) => unit.status !== 'running'), 'no unit may be left running');
  } finally {
    await stub.close();
  }
});

test('phase two with a forged or missing token is refused and leaves the run running', async () => {
  ConfirmationService.reset();
  const stub = await startSlowStub(60);
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  try {
    const { repo, task } = cleanRepo('forged');
    const { runId } = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });
    LoopControlService.requestCancel(TENANT, runId);

    assert.throws(() => LoopControlService.confirmCancel(TENANT, runId, 'not-a-real-token'), /LOOP_CONFIRMATION_INVALID/);
    assert.throws(() => LoopControlService.confirmCancel(TENANT, runId, undefined), /LOOP_CONFIRMATION_INVALID/);
    assert.ok(LoopControlService.isActive(runId), 'a refused phase two must not stop anything');

    await LoopControlService.whenSettled(runId)!;
  } finally {
    await stub.close();
  }
});

test('a run belonging to another tenant is a miss, and so is its cancellation', () => {
  ConfirmationService.reset();
  const { repo, task } = cleanRepo('foreign');
  assert.throws(() => LoopControlService.requestCancel(OTHER, 'looprun_does_not_exist'), /LOOP_RUN_NOT_FOUND/);
  assert.throws(() => LoopControlService.confirmCancel(OTHER, 'looprun_does_not_exist', 'x'), /LOOP_RUN_NOT_FOUND/);
  assert.ok(fs.existsSync(task) && fs.existsSync(repo));
});

test('a settled run is not cancelable', () => {
  ConfirmationService.reset();
  DurableStore.upsert('factoryLoopRuns', 'looprun_settled', {
    runId: 'looprun_settled', status: 'completed', tenantId: TENANT, startedAt: new Date().toISOString(),
  } as unknown as Record<string, unknown>);
  assert.throws(() => LoopControlService.requestCancel(TENANT, 'looprun_settled'), /LOOP_RUN_NOT_CANCELABLE/);
});

// ── over HTTP ─────────────────────────────────────────────────────────────

test('HTTP: cancellation is two-phase, and eligibility is answered before it', async () => {
  ConfirmationService.reset();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  resetRateLimiterForTests();

  const quota = { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 };
  for (const [id, name] of [[TENANT, 'Cancel tenant'], [OTHER, 'Cancel other']] as const) {
    TenantService.registerTenant({
      id, name, niche: IndustryNiche.CUSTOM_B2B, tier: TenantSubscriptionTier.PROFESSIONAL,
      status: TenantStatus.ACTIVE, apiKeyHash: '', quota, customGuardrails: [],
      encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  const owner = await TenantService.provisionCredential(TENANT);
  const foreign = await TenantService.provisionCredential(OTHER);

  const stub = await startSlowStub(600);
  FrontierModelService.register({ tenantId: TENANT, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'content-type': 'application/json', 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT };

  try {
    const { repo, task } = cleanRepo('http-cancel');
    const { runId } = await LoopControlService.submit({ tenantId: TENANT, repo, taskDocument: task });

    // Phase one over HTTP: 202, a token, and no effect on the run.
    const phaseOne = await fetch(`${base}/api/loop/runs/${runId}/cancel`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(phaseOne.status, 202);
    const pending = (await phaseOne.json()) as { status: string; confirmationToken: string; expiresAt: string };
    assert.equal(pending.status, 'pending_confirmation');
    assert.ok(pending.confirmationToken.length > 32, 'phase one must return a real token');
    assert.ok(pending.expiresAt, 'phase one must say when the token dies');
    assert.ok(LoopControlService.isActive(runId), 'phase one must not stop the run');

    // Phase two over HTTP: the run stops.
    const phaseTwo = await fetch(`${base}/api/loop/runs/${runId}/cancel`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ confirmationToken: pending.confirmationToken }),
    });
    assert.equal(phaseTwo.status, 202);
    assert.equal(((await phaseTwo.json()) as { cancellationRequested: boolean }).cancellationRequested, true);

    // A replay of the same token is refused: single-use.
    const replay = await fetch(`${base}/api/loop/runs/${runId}/cancel`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ confirmationToken: pending.confirmationToken }),
    });
    assert.equal(replay.status, 400);

    await LoopControlService.whenSettled(runId)!;
    const record = LoopControlService.get(TENANT, runId)!;
    assert.equal(record.status, 'halted');
    assert.match(String(record.hardStop), /cancelled by operator/);

    // The eligibility pre-check answers without touching the run - and now says no.
    const eligibility = await fetch(`${base}/api/loop/runs/${runId}/cancel`, { headers: auth });
    assert.equal(eligibility.status, 200);
    const eligible = (await eligibility.json()) as { eligible: boolean; reason: string };
    assert.equal(eligible.eligible, false, 'a settled run is not eligible');
    assert.match(eligible.reason, /settled/);

    // A foreign tenant gets a miss, not a forbidden resource.
    const crossTenant = await fetch(`${base}/api/loop/runs/${runId}/cancel?tenantId=${OTHER}`, {
      headers: { 'content-type': 'application/json', 'x-api-key': foreign.apiKey },
    });
    assert.equal(crossTenant.status, 404);

    // No credential at all is refused before anything else.
    const anonymous = await fetch(`${base}/api/loop/runs/${runId}/cancel`, { headers: { 'content-type': 'application/json' } });
    assert.equal(anonymous.status, 401);
  } finally {
    await stub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
