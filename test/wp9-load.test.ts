/**
 * WP-9: the service survives concurrent load without losing a write.
 *
 * The suite proved the ledger has a single-writer lock across processes
 * (`durable-store-writer-lock.test.ts`) and that the layers behave over HTTP, but nothing fired
 * many requests at the real API at once and then asserted every one of them was persisted. A
 * store can look correct under sequential tests and still drop interleaved writes: two requests
 * read the same in-memory snapshot, both append, and one change is lost.
 *
 * This is a load test, not a unit test: it boots the real app on an ephemeral port and drives
 * `POST /api/factory-jobs` concurrently over the same real transport the layer harnesses use,
 * then asserts the ledger holds exactly what was sent -- and still holds it after the in-memory
 * copy is dropped and re-hydrated from disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wp9-load-'));
process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = DATA_DIR;
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;

const CONCURRENCY = 60;

const { apiRouter } = await import('../src/api');
const { TenantService } = await import('../src/services/tenantService');
const { DurableStore } = await import('../src/services/durableStore');
const { FactoryJobService } = await import('../src/services/factoryJobService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

const TENANT = 'tenant_wp9_load_0001';

TenantService.registerTenant({
  id: TENANT, name: 'WP-9 load tenant', niche: IndustryNiche.CUSTOM_B2B, tier: TenantSubscriptionTier.PROFESSIONAL,
  status: TenantStatus.ACTIVE, apiKeyHash: '',
  quota: { maxRequestsPerMinute: 100_000, maxDailyAiTokens: 10_000_000, burstCapacity: 10_000, storageLimitMb: 1000 },
  customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const credential = await TenantService.provisionCredential(TENANT);

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function appWithRoutes(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

test('WP-9: concurrent creates are all persisted, none lost, and survive a reload', async () => {
  DurableStore.resetForTests();
  resetRateLimiterForTests();
  const server = await listen(appWithRoutes());
  try {
    const headers = { 'content-type': 'application/json', 'x-api-key': credential.apiKey, 'x-tenant-id': TENANT };
    const startedAt = Date.now();
    const responses = await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) =>
      fetch(`${server.url}/api/factory-jobs`, {
        method: 'POST', headers,
        body: JSON.stringify({ tenantId: TENANT, title: `Load job ${index}`, problem: 'p', desiredOutcome: 'o' }),
      })));
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual([...new Set(responses.map((response) => response.status))], [201], 'every concurrent create must succeed');

    // No lost writes: the ledger holds exactly the jobs that were sent, and each title is unique.
    const live = FactoryJobService.list(TENANT);
    assert.equal(live.length, CONCURRENCY, `expected ${CONCURRENCY} persisted jobs, found ${live.length}`);
    assert.equal(new Set(live.map((job) => job.title)).size, CONCURRENCY, 'every request must have produced its own record');

    // Durability under load: drop the in-memory copy and re-hydrate from disk.
    DurableStore.resetForTests();
    const reloaded = FactoryJobService.list(TENANT);
    assert.equal(reloaded.length, CONCURRENCY, 'a reload from disk must still hold every write');

    // A generous ceiling: catches pathological serialization, but is not a flaky latency SLA.
    assert.ok(elapsedMs < CONCURRENCY * 500, `${CONCURRENCY} creates took ${elapsedMs}ms`);
  } finally {
    await server.close();
  }
});
