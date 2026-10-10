/**
 * WP-4: cross-tenant READ refusal at the real HTTP boundary.
 *
 * Existing isolation tests cover the ingest/write path and the loop read path. The
 * telemetry read routes (`/api/telemetry/history`, `/api/telemetry/audit`) and the tenant
 * registry (`GET /api/tenants`, `GET /api/tenants/:id`) had no such proof.
 *
 * The registry routes were worse than untested: they were unbound. A tenant credential
 * could enumerate every partition and read any tenant's quota and guardrails by guessing
 * its id, because `validateTenantRequest` inspects only the header/body/query claim and
 * never the path parameter. That is a "cross-tenant read refused" failure, and these tests
 * are the negative proof.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = `/tmp/opencode/sf-wp4-${process.pid}`;
process.env.FACTORY_API_KEY = 'platform-key-wp4-test';
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;

const TENANT = 'tenant_wp4_0001';
const OTHER = 'tenant_wp4_0002';
const PLATFORM_KEY = 'platform-key-wp4-test';

const { apiRouter } = await import('../src/api');
const { TenantService } = await import('../src/services/tenantService');
const { AppwriteService } = await import('../src/services/appwriteService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

function registerTenant(id: string, name: string): void {
  TenantService.registerTenant({
    id, name, niche: IndustryNiche.CUSTOM_B2B, tier: TenantSubscriptionTier.PROFESSIONAL,
    status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

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

function auth(key: string, claim: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': key, 'x-tenant-id': claim };
}

registerTenant(TENANT, 'WP4 tenant');
registerTenant(OTHER, 'WP4 other');
const root = await TenantService.provisionCredential(TENANT);

// The read handlers delegate to the store; stub it so the test proves the AUTHORISATION
// boundary, not the store.
AppwriteService.getTransformationsByTenant = async () => [];
AppwriteService.getAuditLogs = async () => [];

test('a tenant credential listing partitions sees only its own', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/tenants`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(OTHER), 'another tenant must never appear in the list');
    const body = JSON.parse(raw) as { count: number; tenants: { id: string }[] };
    assert.equal(body.count, 1);
    assert.deepEqual(body.tenants.map((t) => t.id), [TENANT]);
  } finally {
    await server.close();
  }
});

test('a tenant credential cannot read another tenant profile by id', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/tenants/${OTHER}`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(res.status, 403, 'guessing another tenant id must be refused');
    assert.equal(((await res.json()) as { code: string }).code, 'TENANT_CREDENTIAL_MISMATCH');
  } finally {
    await server.close();
  }
});

test('a tenant credential can read its own profile by id', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/tenants/${TENANT}`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenant: { id: string } };
    assert.equal(body.tenant.id, TENANT);
  } finally {
    await server.close();
  }
});

test('a platform operator may enumerate partitions', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/tenants`, { headers: auth(PLATFORM_KEY, TENANT) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { count: number };
    assert.ok(body.count >= 2, 'the operator sees both partitions');
  } finally {
    await server.close();
  }
});

test('telemetry history refuses a foreign tenant claim', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/telemetry/history?tenantId=${OTHER}`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'TENANT_CREDENTIAL_MISMATCH');
  } finally {
    await server.close();
  }
});

test('telemetry history answers for its own tenant', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/telemetry/history?tenantId=${TENANT}`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

test('telemetry audit refuses a foreign tenant claim', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const res = await fetch(`${server.url}/api/telemetry/audit?tenantId=${OTHER}`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'TENANT_CREDENTIAL_MISMATCH');
  } finally {
    await server.close();
  }
});
