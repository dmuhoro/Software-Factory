/**
 * The learning digest (Sprint 29, WP-6 / ADR-012).
 *
 * These cases pin the ADR's invariants: the digest is a pure, deterministic, bounded, tenant-scoped
 * summary of recorded runs; below the sufficiency threshold it is an explicit `insufficient-data`
 * record rather than a conclusion; and prompt injection defaults **off** and is provably a no-op
 * (the prompt is byte-identical) until an operator turns it on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-learning-digest-'));
const workspace = fs.mkdtempSync(path.join(state, 'ws-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = workspace;
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const {
  buildLearningDigest, injectLearningDigest, LearningDigestService,
  MINIMUM_COMPLETED_RUNS, MAX_ENTRIES_PER_SECTION, MAX_TOTAL_ENTRIES, MAX_SERIALIZED_BYTES,
} = await import('../src/services/learningDigestService');
const { buildGoalPrompt } = await import('../src/services/goalIntakeService');
const { DoctrineService } = await import('../src/services/doctrineService');
const { DurableStore } = await import('../src/services/durableStore');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');
import type { LoopRunRecord, UnitRecord, GateResult, AttemptRecord } from '../src/services/loopTypes';

DurableStore.resetForTests();

const ISO = '2026-01-01T00:00:00.000Z';

function attempt(reason: string, passed = false): AttemptRecord {
  return { attempt: 1, startedAt: ISO, finishedAt: ISO, stage: 'verify', passed, reason, detail: '' };
}

function stuckUnit(attempts: AttemptRecord[]): UnitRecord {
  return { unitId: `u_${attempts[0]?.reason ?? 'x'}`, milestoneId: 'M1', title: 'unit', type: 'feature', criteria: [], dependsOn: [], status: 'stuck', attempts };
}

function failedGate(id: string): GateResult {
  return { id, stage: 'commit', timing: 'before', passed: false, blocking: true, detail: '', checkedAt: ISO };
}

function completedRun(overrides: Partial<LoopRunRecord> & { tenantId: string; runId: string }): LoopRunRecord {
  return {
    status: 'completed', startedAt: ISO, repo: '/r', taskDocument: '/t', taskDocumentHash: 'h',
    doctrineDigest: 'd', execution: 'sequential', attemptCap: 3, quarantineCount: 0,
    units: [], commits: [], gates: [], events: [], models: [], narrationRejected: 0,
    ...overrides,
  } as LoopRunRecord;
}

// ── the pure builder ────────────────────────────────────────────────────────

test('the digest is deterministic: the same records produce byte-identical JSON', () => {
  const runs = [
    completedRun({ runId: 'r1', tenantId: 'A', failureClass: 'verification', gates: [failedGate('ground-truth')], units: [stuckUnit([attempt('GROUND_TRUTH')]) ] }),
    completedRun({ runId: 'r2', tenantId: 'A', failureClass: 'verification', gates: [failedGate('ground-truth')], units: [stuckUnit([attempt('GROUND_TRUTH')]) ] }),
    completedRun({ runId: 'r3', tenantId: 'A', failureClass: 'review', gates: [failedGate('review')], units: [stuckUnit([attempt('REVIEW_REFUSED')]) ] }),
    completedRun({ runId: 'r4', tenantId: 'A', failureClass: 'verification', gates: [], units: [] }),
    completedRun({ runId: 'r5', tenantId: 'A', failureClass: 'verification', gates: [], units: [] }),
  ];
  const first = buildLearningDigest(runs, 'A');
  const second = buildLearningDigest(runs, 'A');
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'the same records must serialize identically');
  assert.deepEqual(first, second);
  // Order does not matter: a shuffled copy yields the same digest.
  const shuffled = buildLearningDigest([runs[2], runs[0], runs[4], runs[1], runs[3]], 'A');
  assert.equal(JSON.stringify(shuffled), JSON.stringify(first), 'input order must not change the digest');
});

test('below the sufficiency threshold the digest is an explicit insufficient-data record', () => {
  const runs = Array.from({ length: MINIMUM_COMPLETED_RUNS - 1 }, (_, i) => completedRun({ runId: `r${i}`, tenantId: 'A' }));
  const digest = buildLearningDigest(runs, 'A');
  assert.equal(digest.status, 'insufficient-data');
  assert.equal(digest.completedRuns, MINIMUM_COMPLETED_RUNS - 1);
  assert.equal(digest.minimumCompletedRuns, MINIMUM_COMPLETED_RUNS);
  assert.deepEqual(digest.failureClasses, [], 'no conclusion is drawn below the threshold');
  assert.deepEqual(digest.refusedGates, []);
  assert.deepEqual(digest.stuckReasons, []);
  assert.match(digest.note, /insufficient data/, 'the record says what is missing');
});

test('a non-completed run does not count toward the threshold', () => {
  const four = Array.from({ length: 4 }, (_, i) => completedRun({ runId: `r${i}`, tenantId: 'A' }));
  const halted = completedRun({ runId: 'h', tenantId: 'A', status: 'halted' });
  const digest = buildLearningDigest([...four, halted], 'A');
  assert.equal(digest.status, 'insufficient-data');
  assert.equal(digest.totalRuns, 5);
  assert.equal(digest.completedRuns, 4);
});

test('at the threshold the digest counts failure classes, refused gates and refusal codes', () => {
  const runs = [
    ...Array.from({ length: 3 }, (_, i) => completedRun({ runId: `v${i}`, tenantId: 'A', failureClass: 'verification', gates: [failedGate('ground-truth')], units: [stuckUnit([attempt('GROUND_TRUTH')])] })),
    ...Array.from({ length: 2 }, (_, i) => completedRun({ runId: `r${i}`, tenantId: 'A', failureClass: 'review', gates: [failedGate('review')], units: [stuckUnit([attempt('REVIEW_REFUSED')])] })),
  ];
  const digest = buildLearningDigest(runs, 'A');
  assert.equal(digest.status, 'ok');
  assert.deepEqual(digest.failureClasses, [{ key: 'verification', count: 3 }, { key: 'review', count: 2 }]);
  assert.deepEqual(digest.refusedGates, [{ key: 'ground-truth', count: 3 }, { key: 'review', count: 2 }]);
  assert.deepEqual(digest.stuckReasons, [{ key: 'GROUND_TRUTH', count: 3 }, { key: 'REVIEW_REFUSED', count: 2 }]);
});

test('entries are ordered by count descending, then key ascending', () => {
  const runs = [
    completedRun({ runId: 'a', tenantId: 'A', failureClass: 'review', gates: [], units: [] }),
    completedRun({ runId: 'b', tenantId: 'A', failureClass: 'review', gates: [], units: [] }),
    completedRun({ runId: 'c', tenantId: 'A', failureClass: 'model', gates: [], units: [] }),
    completedRun({ runId: 'd', tenantId: 'A', failureClass: 'model', gates: [], units: [] }),
    completedRun({ runId: 'e', tenantId: 'A', failureClass: 'environment', gates: [], units: [] }),
  ];
  const digest = buildLearningDigest(runs, 'A');
  assert.deepEqual(digest.failureClasses, [
    { key: 'model', count: 2 },
    { key: 'review', count: 2 },
    { key: 'environment', count: 1 },
  ], 'ties break by ascending key');
});

test('the digest is bounded: excess entries are dropped and truncation is explicit', () => {
  const many = Array.from({ length: 60 }, (_, i) => attempt(`REASON_${String(i).padStart(2, '0')}`));
  const runs = Array.from({ length: MINIMUM_COMPLETED_RUNS }, (_, i) => completedRun({ runId: `r${i}`, tenantId: 'A', units: [stuckUnit(many)] }));
  const digest = buildLearningDigest(runs, 'A');
  assert.equal(digest.status, 'ok');
  assert.ok(digest.stuckReasons.length <= MAX_ENTRIES_PER_SECTION, 'a section never exceeds its cap');
  const total = digest.failureClasses.length + digest.refusedGates.length + digest.stuckReasons.length;
  assert.ok(total <= MAX_TOTAL_ENTRIES, 'the total never exceeds its cap');
  assert.equal(digest.truncated, true, 'dropping entries must be reported');
  assert.ok(digest.omittedEntries > 0, 'the number of omitted entries must be reported');
  assert.ok(Buffer.byteLength(JSON.stringify(digest), 'utf8') <= MAX_SERIALIZED_BYTES, 'the serialized digest must fit the byte bound');
});

// ── the read-only service ───────────────────────────────────────────────────

test('the service reads only the named tenant and never crosses the boundary', () => {
  const tenantA = 'digest-tenant-a';
  const tenantB = 'digest-tenant-b';
  for (let i = 0; i < MINIMUM_COMPLETED_RUNS; i += 1) {
    DurableStore.upsert('factoryLoopRuns', `durable-a-${i}`, completedRun({ runId: `durable-a-${i}`, tenantId: tenantA, failureClass: 'verification' }) as unknown as Record<string, unknown>);
  }
  DurableStore.upsert('factoryLoopRuns', 'durable-b-0', completedRun({ runId: 'durable-b-0', tenantId: tenantB, failureClass: 'model' }) as unknown as Record<string, unknown>);

  const digestA = LearningDigestService.build(tenantA);
  assert.equal(digestA.tenantId, tenantA);
  assert.equal(digestA.totalRuns, MINIMUM_COMPLETED_RUNS);
  assert.deepEqual(digestA.failureClasses, [{ key: 'verification', count: MINIMUM_COMPLETED_RUNS }]);
  assert.ok(!digestA.failureClasses.some((entry) => entry.key === 'model'), "another tenant's runs must not leak in");

  const digestB = LearningDigestService.build(tenantB);
  assert.equal(digestB.totalRuns, 1);
  assert.equal(digestB.status, 'insufficient-data');
});

// ── the injection seam (ADR-012 §6) ─────────────────────────────────────────

test('injection is a provable no-op when disabled', () => {
  const runs = Array.from({ length: MINIMUM_COMPLETED_RUNS }, (_, i) => completedRun({ runId: `n${i}`, tenantId: 'A', failureClass: 'verification' }));
  const digest = buildLearningDigest(runs, 'A');
  const task = 'Goal: add the alpha feature\n\nTarget repository root: /r\n\nWrite the task document now.';
  assert.equal(injectLearningDigest(task, digest, false), task, 'disabled injection must return the task byte-for-byte');
  assert.equal(injectLearningDigest(task, undefined, true), task, 'no digest means nothing to append');
  const insufficient = buildLearningDigest([completedRun({ runId: 'only', tenantId: 'A' })], 'A');
  assert.equal(injectLearningDigest(task, insufficient, true), task, 'an insufficient-data digest is not injected');
});

test('the goal prompt is byte-identical whether or not the disabled seam is passed', () => {
  const withoutSeam = buildGoalPrompt(workspace, 'ship it', 'p', 'm');
  const withDisabledSeam = buildGoalPrompt(workspace, 'ship it', 'p', 'm', { enabled: false });
  assert.equal(withoutSeam.task, withDisabledSeam.task, 'the default and the disabled flag must produce the same prompt');
  assert.equal(withoutSeam.system, withDisabledSeam.system);
});

test('injection appends a deterministic, fenced digest block when enabled', () => {
  const runs = Array.from({ length: MINIMUM_COMPLETED_RUNS }, (_, i) => completedRun({ runId: `e${i}`, tenantId: 'A', failureClass: 'review', gates: [failedGate('review')] }));
  const digest = buildLearningDigest(runs, 'A');
  const task = 'base task';
  const injected = injectLearningDigest(task, digest, true);
  assert.ok(injected.startsWith(task), 'the original task text is preserved');
  assert.match(injected, /learning digest/i);
  assert.match(injected, /review=5/);
  assert.equal(injected, injectLearningDigest(task, digest, true), 'the same digest renders the same block');
});

// ── the doctrine flag defaults off ──────────────────────────────────────────

test('the shipped doctrine leaves learning injection off', () => {
  const loop = DoctrineService.load().loop;
  assert.equal(loop.learning.inject, false, 'injection must be OFF in the shipped doctrine (ADR-012 §6)');
});

// ── the route ───────────────────────────────────────────────────────────────

test('GET /api/loop/learning-digest is 401 without a credential and tenant-scoped with one', async () => {
  const TENANT = 'digest-route-tenant';
  const OTHER = 'digest-route-other';
  const quota = { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 };
  for (const [id, name] of [[TENANT, 'Digest tenant'], [OTHER, 'Digest other']] as const) {
    TenantService.registerTenant({
      id, name, niche: IndustryNiche.CUSTOM_B2B, tier: TenantSubscriptionTier.PROFESSIONAL,
      status: TenantStatus.ACTIVE, apiKeyHash: '', quota, customGuardrails: [],
      encryptionKeyId: 'test', createdAt: ISO, updatedAt: ISO,
    });
  }
  const owner = await TenantService.provisionCredential(TENANT);
  resetRateLimiterForTests();

  for (let i = 0; i < MINIMUM_COMPLETED_RUNS; i += 1) {
    DurableStore.upsert('factoryLoopRuns', `route-${i}`, completedRun({ runId: `route-${i}`, tenantId: TENANT, failureClass: 'environment' }) as unknown as Record<string, unknown>);
  }

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const anonymous = await fetch(`${base}/api/loop/learning-digest`);
    assert.equal(anonymous.status, 401, 'an unauthenticated read must be refused');

    const response = await fetch(`${base}/api/loop/learning-digest`, { headers: { 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; digest: { tenantId: string; status: string; failureClasses: Array<{ key: string }> } };
    assert.equal(body.status, 'success');
    assert.equal(body.digest.tenantId, TENANT);
    assert.deepEqual(body.digest.failureClasses, [{ key: 'environment', count: MINIMUM_COMPLETED_RUNS }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
