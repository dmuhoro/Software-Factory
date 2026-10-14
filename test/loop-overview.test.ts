/**
 * The fleet read surface (Sprint 30, WP-3).
 *
 * A thin client needs one read that answers "how are my runs doing, and what have we learned" without
 * walking the ledger itself. This is that read: tenant-scoped, derived from the durable ledger, and
 * strictly read-only — it starts no run and adds no mutating route.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-overview-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { LoopControlService, countRunsByStatus } = await import('../src/services/loopControlService');
const { DurableStore } = await import('../src/services/durableStore');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

const ISO = '2026-01-01T00:00:00.000Z';
const TENANT = 'overview-tenant';
const OTHER = 'overview-other';

function runRecord(id: string, tenantId: string, status: string): Record<string, unknown> {
  return {
    runId: id, status, tenantId, startedAt: ISO, repo: '/r', taskDocument: '/t', taskDocumentHash: 'h',
    doctrineDigest: 'd', execution: 'sequential', attemptCap: 3, quarantineCount: 0,
    units: [], commits: [], gates: [], events: [], models: [], narrationRejected: 0,
  };
}

test('countRunsByStatus is total: every status is present, zero when absent', () => {
  assert.deepEqual(countRunsByStatus([]), { running: 0, completed: 0, halted: 0, refused: 0 });
  assert.deepEqual(
    countRunsByStatus([
      { status: 'completed' }, { status: 'completed' }, { status: 'halted' }, { status: 'running' },
    ] as never),
    { running: 1, completed: 2, halted: 1, refused: 0 },
  );
});

test('GET /api/loop/overview is tenant-scoped, read-only, and carries the digest', async () => {
  for (const [id, name] of [[TENANT, 'Overview tenant'], [OTHER, 'Overview other']] as const) {
    TenantService.registerTenant({
      id, name, niche: IndustryNiche.CUSTOM_B2B, tier: TenantSubscriptionTier.PROFESSIONAL,
      status: TenantStatus.ACTIVE, apiKeyHash: '',
      quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
      customGuardrails: [], encryptionKeyId: 'test', createdAt: ISO, updatedAt: ISO,
    });
  }
  const owner = await TenantService.provisionCredential(TENANT);
  const other = await TenantService.provisionCredential(OTHER);
  resetRateLimiterForTests();

  DurableStore.upsert('factoryLoopRuns', 'ov-1', runRecord('ov-1', TENANT, 'completed'));
  DurableStore.upsert('factoryLoopRuns', 'ov-2', runRecord('ov-2', TENANT, 'halted'));
  DurableStore.upsert('factoryLoopRuns', 'ov-foreign', runRecord('ov-foreign', OTHER, 'completed'));

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT };

  try {
    const anonymous = await fetch(`${base}/api/loop/overview`);
    assert.equal(anonymous.status, 401, 'the fleet view must not be served to an unauthenticated caller');

    const before = DurableStore.list('factoryLoopRuns').length;
    const response = await fetch(`${base}/api/loop/overview`, { headers: auth });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      overview: { totalRuns: number; byStatus: Record<string, number>; runs: Array<{ runId: string }> };
      digest: { tenantId: string; status: string };
    };
    assert.equal(body.status, 'success');
    assert.equal(body.overview.totalRuns, 2, 'only this tenant\'s runs are counted');
    assert.deepEqual(body.overview.byStatus, { running: 0, completed: 1, halted: 1, refused: 0 });
    assert.ok(!body.overview.runs.some((run) => run.runId === 'ov-foreign'), 'a foreign run must not appear');
    assert.equal(body.digest.tenantId, TENANT);

    const after = DurableStore.list('factoryLoopRuns').length;
    assert.equal(after, before, 'the overview read must not write to the ledger');

    // Read-only: there is no POST handler for this path.
    const post = await fetch(`${base}/api/loop/overview`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 404, 'the overview is a read; it must not accept a write verb');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
