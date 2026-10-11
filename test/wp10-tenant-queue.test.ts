/**
 * WP-10 part 2: per-tenant queue isolation and fair-share.
 *
 * The resource governor bounds *host* concurrency but has no notion of who is asking. One tenant
 * with many repositories could take every admitted slot, so "the host cap" was never tenant
 * isolation. This puts the missing boundary on trial at the real submission path:
 *
 *  - a tenant holds only its tier's allowance (starter 1, professional 2, enterprise 4), and the
 *    refusal names the limit rather than queueing silently;
 *  - a principal the registry does not know is held to the conservative cap, not waved through;
 *  - the host cap still wins: an enterprise tenant alone cannot exceed it;
 *  - when tenants compete, no single tenant can take the whole host (fair share);
 *  - the live submit path reserves a slot before work starts and releases it when the run settles,
 *    so a second submission while the tenant is full is refused by name, and accepted again once
 *    the run finishes.
 *
 * Failing-first: removing the `TenantQueueService.acquire` call in `LoopControlService.submit`
 * makes the integration arm's second submission succeed instead of being refused; removing the
 * release in the run's settle handler leaves `inFlightCount` at 1 and fails the "freed once the
 * run settles" assertion.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { TenantSubscriptionTier as TenantTier } from '../src/models/tenant';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-tenant-queue-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { TenantQueueService } = await import('../src/services/tenantQueueService');
const { LoopControlService } = await import('../src/services/loopControlService');
const { FrontierModelService } = await import('../src/services/frontierModelService');
const { TenantService } = await import('../src/services/tenantService');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

const STARTER = TenantSubscriptionTier.STARTER;
const PROFESSIONAL = TenantSubscriptionTier.PROFESSIONAL;
const ENTERPRISE = TenantSubscriptionTier.ENTERPRISE;

function register(id: string, tier: TenantTier): void {
  TenantService.registerTenant({
    id, name: id, niche: IndustryNiche.CUSTOM_B2B, tier, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

/** Runs `body` with the given env vars set, restoring the previous values afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    TenantQueueService.resetForTests();
  }
}

// ── pure admission rules ────────────────────────────────────────────────────

test('every tier may hold exactly its allowance and the refusal names the cap', async () => {
  await withEnv({ FACTORY_MAX_PARALLEL: '8', FACTORY_TENANT_CONCURRENCY: undefined }, () => {
    const cases: Array<{ id: string; tier: TenantTier; allowed: number }> = [
      { id: 'q-starter', tier: STARTER, allowed: 1 },
      { id: 'q-pro', tier: PROFESSIONAL, allowed: 2 },
      { id: 'q-ent', tier: ENTERPRISE, allowed: 4 },
    ];
    for (const { id, tier, allowed } of cases) {
      TenantQueueService.resetForTests();
      register(id, tier);
      for (let i = 0; i < allowed; i += 1) {
        const admission = TenantQueueService.acquire(id, `${id}-${i}`);
        assert.equal(admission.admitted, true, `${tier} must admit run ${i + 1} of ${allowed}`);
      }
      const refused = TenantQueueService.acquire(id, `${id}-extra`);
      assert.equal(refused.admitted, false, `${tier} must refuse run ${allowed + 1}`);
      assert.ok(refused.reasons.some((reason) => reason.startsWith('TENANT_CAP')), `the refusal must name the tenant cap: ${refused.reasons.join(',')}`);
      assert.ok(refused.leaseId === '', 'a refused admission must hand back no lease');
    }
  });
});

test('an unknown principal is held to the conservative cap, not given the host', async () => {
  await withEnv({ FACTORY_MAX_PARALLEL: '8', FACTORY_TENANT_CONCURRENCY: undefined }, () => {
    assert.equal(TenantService.getTenant('q-ghost'), undefined, 'this arm only means something for an unregistered tenant');
    assert.equal(TenantQueueService.acquire('q-ghost', 'ghost-1').admitted, true);
    const second = TenantQueueService.acquire('q-ghost', 'ghost-2');
    assert.equal(second.admitted, false, 'an unregistered principal must not get a second concurrent run');
    assert.equal(TenantQueueService.limitFor('q-ghost'), 1);
  });
});

test('the host cap wins over the tier: an enterprise tenant alone may not exceed it', async () => {
  await withEnv({ FACTORY_MAX_PARALLEL: '2', FACTORY_TENANT_CONCURRENCY: undefined }, () => {
    register('q-ent-host', ENTERPRISE);
    assert.equal(TenantQueueService.acquire('q-ent-host', 'h-1').admitted, true);
    assert.equal(TenantQueueService.acquire('q-ent-host', 'h-2').admitted, true);
    const third = TenantQueueService.acquire('q-ent-host', 'h-3');
    assert.equal(third.admitted, false);
    assert.ok(third.reasons.some((reason) => reason.startsWith('GLOBAL_CAPACITY')), `the refusal must name the host cap: ${third.reasons.join(',')}`);
  });
});

test('when tenants compete, no single tenant can take the whole host', async () => {
  await withEnv({ FACTORY_MAX_PARALLEL: '4', FACTORY_TENANT_CONCURRENCY: undefined }, () => {
    register('q-a', ENTERPRISE);
    register('q-b', ENTERPRISE);
    register('q-c', ENTERPRISE);

    // A is alone, so its share is the whole host (capped by its tier); it takes a slot.
    assert.equal(TenantQueueService.acquire('q-a', 'a-1').admitted, true);
    // B arrives: now the host is divided by two, so each may hold at most two.
    assert.equal(TenantQueueService.acquire('q-b', 'b-1').admitted, true);
    assert.equal(TenantQueueService.acquire('q-b', 'b-2').admitted, true);
    const bThird = TenantQueueService.acquire('q-b', 'b-3');
    assert.equal(bThird.admitted, false, 'B must be held to its fair share, not its tier cap');
    assert.equal(TenantQueueService.admit('q-b').fairShare, 2);

    // A may grow to its share, filling the host.
    assert.equal(TenantQueueService.acquire('q-a', 'a-2').admitted, true);
    assert.equal(TenantQueueService.totalInFlight(), 4);
    assert.equal(TenantQueueService.admit('q-a').fairShare, 2);

    // C arrives to a full host and is refused -- but by the host cap, never by a share of zero.
    const cFirst = TenantQueueService.acquire('q-c', 'c-1');
    assert.equal(cFirst.admitted, false);
    assert.ok(cFirst.fairShare >= 1, 'a competing tenant must never be given a share of zero');
  });
});

test('releasing a lease frees the slot, and releasing an unknown lease is a miss', async () => {
  await withEnv({ FACTORY_MAX_PARALLEL: '8', FACTORY_TENANT_CONCURRENCY: undefined }, () => {
    register('q-release', STARTER);
    const first = TenantQueueService.acquire('q-release', 'lease-x');
    assert.equal(first.admitted, true);
    assert.equal(TenantQueueService.inFlightCount('q-release'), 1);
    assert.equal(TenantQueueService.release('lease-x'), true);
    assert.equal(TenantQueueService.inFlightCount('q-release'), 0);
    assert.equal(TenantQueueService.acquire('q-release', 'lease-y').admitted, true, 'the freed slot must be reusable');
    assert.equal(TenantQueueService.release('lease-y'), true);
    assert.equal(TenantQueueService.release('lease-unknown'), false);
  });
});

// ── the real submission path ────────────────────────────────────────────────

type Reply = { files: Array<{ path: string; content: string }>; notes?: string };
type ReviewReply = { approved: boolean; findings: string[] };
const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

/** A provider that withholds every reply until `release()` is called, then answers normally. */
async function blockingStub(): Promise<{ url: string; release: () => void; close: () => Promise<void> }> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      void hold.then(() => {
        const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
        const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
        const reply: Reply | ReviewReply = prompt.includes(REVIEW_MARKER)
          ? { approved: true, findings: [] }
          : { files: [{ path: 'feature.txt', content: 'alpha\n' }], notes: 'wrote the feature' };
        const content = ['```json', JSON.stringify(reply), '```'].join('\n');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, release, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const CHECK = [
  "const fs = require('node:fs');",
  "const ok = fs.existsSync('feature.txt') && fs.readFileSync('feature.txt', 'utf8').includes('alpha');",
  "if (!ok) { console.error('missing alpha'); process.exit(1); }",
  "console.log('ok');",
].join('\n');

function cleanRepo(name: string): { repo: string; task: string } {
  const root = fs.mkdtempSync(path.join(workspace, `${name}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const check = path.join(root, 'check.cjs');
  fs.writeFileSync(check, CHECK);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  const task = path.join(workspace, `${name}-task.md`);
  fs.writeFileSync(task, [
    '# Task: Ship the feature',
    '',
    '## Goal',
    'Commit one verified feature.',
    '',
    '## Constraints',
    '- No new dependencies',
    '',
    '## Models',
    'models.implementer: stub/stub-code',
    'models.reviewer: stub/stub-code',
    '',
    '## Milestones',
    '### M1: Feature alpha',
    'type: feat',
    `verify: node ${check}`,
    '- [ ] feature.txt exists and contains alpha',
    '',
  ].join('\n'), 'utf8');
  return { repo: root, task };
}

test('the live submit path reserves a per-tenant slot and releases it when the run settles', async () => {
  const tenant = 'q-live';
  const stub = await blockingStub();
  try {
    await withEnv({ FACTORY_TENANT_CONCURRENCY: '1', FACTORY_MAX_PARALLEL: '4' }, async () => {
      register(tenant, PROFESSIONAL);
      FrontierModelService.register({ tenantId: tenant, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });

      const first = cleanRepo('lease-a');
      const second = cleanRepo('lease-b');

      const run = await LoopControlService.submit({ tenantId: tenant, repo: first.repo, taskDocument: first.task });
      assert.equal(TenantQueueService.inFlightCount(tenant), 1, 'the live path must reserve a slot before work starts');

      // A second repository for the same tenant is refused by name while the first is live.
      await assert.rejects(
        () => LoopControlService.submit({ tenantId: tenant, repo: second.repo, taskDocument: second.task }),
        /TENANT_CONCURRENCY_LIMIT/,
      );

      stub.release();
      const outcome = await LoopControlService.whenSettled(run.runId);
      assert.ok(outcome);
      assert.equal(outcome.record.status, 'completed', `run did not complete: ${outcome.record.hardStop ?? outcome.record.refusal ?? ''}`);
      assert.equal(TenantQueueService.inFlightCount(tenant), 0, 'the slot must be freed once the run settles');

      // With the slot freed, a new repository for the same tenant is accepted again.
      const accepted = await LoopControlService.submit({ tenantId: tenant, repo: second.repo, taskDocument: second.task });
      assert.match(accepted.runId, /^looprun_/);
      await LoopControlService.whenSettled(accepted.runId);
      assert.equal(TenantQueueService.inFlightCount(tenant), 0);
    });
  } finally {
    await stub.close();
  }
});
