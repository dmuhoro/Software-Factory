/**
 * The cross-run memory route (Layer 3 runtime).
 *
 * Exercises the real route handler through an Express test server: the endpoint is tenant-scoped,
 * refuses a filter it does not understand, and never returns another tenant's memory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-memory-route-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

const { DurableStore } = await import('../src/services/durableStore');
const { TenantService } = await import('../src/services/tenantService');
const { PersistentMemoryService } = await import('../src/services/persistentMemoryService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantSubscriptionTier, TenantStatus } = await import('../src/models/tenant');

DurableStore.resetForTests();
TenantService.resetCacheForTests();

const TENANT = 'memory-route-tenant';
const OTHER = 'memory-route-other';

for (const id of [TENANT, OTHER]) {
  TenantService.registerTenant({
    id, name: `Memory Route ${id}`, niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

let tenantKey = '';
let otherKey = '';

test('setup: provision root credentials', async () => {
  tenantKey = (await TenantService.provisionCredential(TENANT)).apiKey;
  otherKey = (await TenantService.provisionCredential(OTHER)).apiKey;
  resetRateLimiterForTests();
});

async function withServer(body: (call: (path: string, apiKey?: string, tenantId?: string) => Promise<{ status: number; body: any }>) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const call = async (urlPath: string, apiKey = tenantKey, tenantId = TENANT) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, {
      headers: { 'x-api-key': apiKey, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await body(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the memories route returns only the authenticated tenant\'s memory', async () => {
  PersistentMemoryService.record({
    tenantId: TENANT, kind: 'warning', summary: 'M1 failed at verify (verification): GATE_REFUSED', detail: 'detail', unitId: 'M1', failureClass: 'verification',
  });
  PersistentMemoryService.record({
    tenantId: OTHER, kind: 'warning', summary: 'M2 failed at verify (verification): GATE_REFUSED', detail: 'detail', unitId: 'M2', failureClass: 'verification',
  });

  await withServer(async (call) => {
    const mine = await call('/loop/memories');
    assert.equal(mine.status, 200);
    const memories = mine.body.memories as Array<{ summary: string }>;
    assert.equal(memories.length, 1, 'the route returned another tenant\'s memory');
    assert.match(memories[0].summary, /M1/);

    const theirs = await call('/loop/memories', otherKey, OTHER);
    const otherMemories = theirs.body.memories as Array<{ summary: string }>;
    assert.equal(otherMemories.length, 1);
    assert.match(otherMemories[0].summary, /M2/);
  });
});

test('the memories route refuses a filter it does not understand', async () => {
  await withServer(async (call) => {
    const badKind = await call('/loop/memories?kind=nonsense');
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.code, 'MEMORY_KIND_NOT_RECOGNIZED');

    const badLimit = await call('/loop/memories?limit=100000');
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.body.code, 'MEMORY_LIMIT_OUT_OF_RANGE');
  });
});

test('the memories route requires authentication', async () => {
  await withServer(async (call) => {
    const anonymous = await call('/loop/memories', '', TENANT);
    assert.ok(anonymous.status === 401 || anonymous.status === 403, `expected a refusal, got ${anonymous.status}`);
  });
});
