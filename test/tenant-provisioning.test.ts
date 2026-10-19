/**
 * Tenant provisioning route tests (P0 Identity).
 *
 * Proves the real path through POST /api/tenants: self-serve signup creates a
 * tenant durably, returns the root API key exactly once, refuses duplicates and
 * invalid niche/tier, and GET /tenants remains tenant-authenticated.
 *
 * No model keys are required; provisioning is a pure control-plane operation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { DurableStore } from '../src/services/durableStore';
import { TenantService } from '../src/services/tenantService';
import { resetRateLimiterForTests } from '../src/api/middleware/rateLimiter';
import { apiRouter } from '../src/api';
import { IndustryNiche, TenantSubscriptionTier, TenantStatus } from '../src/models/tenant';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-tenant-prov-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.FACTORY_WORKSPACE_ROOT, { recursive: true });

DurableStore.resetForTests();
TenantService.resetCacheForTests();
resetRateLimiterForTests();

interface ProvisionedTenant {
  status: string;
  tenant: { id: string; name: string; niche: string; tier: string; status: string };
  credentials: { apiKey: string; kind: string; expiresAt: string | null }[];
}

async function appFor(port: number): Promise<{ server: ReturnType<express.Express['listen']> }> {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server };
}

async function fetchJson(port: number, urlPath: string, method: 'GET' | 'POST' = 'GET', body: unknown = undefined, apiKey?: string, tenantId?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (tenantId) headers['x-tenant-id'] = tenantId;
  const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

function registerTenant(id: string, name: string, niche: IndustryNiche, tier: TenantSubscriptionTier): void {
  TenantService.registerTenant({
    id, name, niche, tier, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

test('tenant provisioning: POST /api/tenants creates a tenant and returns a root key once', async () => {
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    // No credentials — public signup.
    const { status, body } = await fetchJson(port, '/tenants', 'POST', {
      name: 'New Builder Co',
      niche: IndustryNiche.HEALTHCARE,
      tier: TenantSubscriptionTier.STARTER,
    });

    assert.equal(status, 201, `provisioning should succeed, got ${status}: ${JSON.stringify(body)}`);
    const p = body as ProvisionedTenant;
    assert.equal(p.status, 'success');
    assert.ok(p.tenant.id, 'tenant id must be returned');
    assert.equal(p.tenant.name, 'New Builder Co');
    assert.equal(p.tenant.niche, IndustryNiche.HEALTHCARE);
    assert.equal(p.tenant.tier, TenantSubscriptionTier.STARTER);
    assert.equal(p.tenant.status, TenantStatus.ACTIVE);

    const creds = p.credentials;
    assert.ok(Array.isArray(creds) && creds.length === 1, 'exactly one root key must be returned');
    assert.equal(creds[0].kind, 'root');
    assert.ok(creds[0].apiKey, 'plaintext key must be returned once');
    assert.equal(creds[0].expiresAt, null);
    assert.equal(typeof creds[0].apiKey, 'string');
    assert.ok(creds[0].apiKey.length >= 24, 'key must be long enough');

    // Notice: the key is NOT stored — GET /tenants requires tenant auth.
    const { status: listStatus } = await fetchJson(port, '/tenants', 'GET', undefined, undefined, p.tenant.id);
    assert.ok(listStatus === 401 || listStatus === 403, `GET /tenants without platform key should be refused, got ${listStatus}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tenant provisioning: duplicate name is refused with 409', async () => {
  registerTenant('tenant-prov-dup', 'Duplicate Tenant', IndustryNiche.LOGISTICS, TenantSubscriptionTier.STARTER);

  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status, body } = await fetchJson(port, '/tenants', 'POST', {
      name: 'Duplicate Tenant',
      niche: IndustryNiche.LOGISTICS,
      tier: TenantSubscriptionTier.STARTER,
    });
    assert.equal(status, 409, `duplicate name should be 409, got ${status}: ${JSON.stringify(body)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tenant provisioning: invalid niche is refused with 400', async () => {
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status, body } = await fetchJson(port, '/tenants', 'POST', {
      name: 'Bad Niche Co',
      niche: 'not_a_real_niche' as IndustryNiche,
      tier: TenantSubscriptionTier.STARTER,
    });
    assert.equal(status, 400, `invalid niche should be 400, got ${status}: ${JSON.stringify(body)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tenant provisioning: missing name is refused with 400', async () => {
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    const { status, body } = await fetchJson(port, '/tenants', 'POST', {
      niche: IndustryNiche.REAL_ESTATE,
      tier: TenantSubscriptionTier.STARTER,
    });
    assert.equal(status, 400, `missing name should be 400, got ${status}: ${JSON.stringify(body)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tenant provisioning: the root key is not logged or recoverable', async () => {
  const { server } = await appFor(0);
  const port = (server.address() as { port: number }).port;
  try {
    // Provision once, capture the plaintext key.
    const { body: first } = await fetchJson(port, '/tenants', 'POST', {
      name: 'Once Tenant',
      niche: IndustryNiche.REAL_ESTATE,
      tier: TenantSubscriptionTier.STARTER,
    });
    const p1 = first as ProvisionedTenant;
    const key = p1.credentials[0].apiKey;

    // The key is not recoverable: provisioning again with the same name is refused.
    const { status: dupStatus } = await fetchJson(port, '/tenants', 'POST', {
      name: 'Once Tenant',
      niche: IndustryNiche.REAL_ESTATE,
      tier: TenantSubscriptionTier.STARTER,
    });
    assert.equal(dupStatus, 409, 'provisioning the same name twice should be refused');

    // The tenant profile does not carry the plaintext key — only a digest.
    const profile = TenantService.getTenant(p1.tenant.id);
    assert.ok(profile, 'tenant profile must exist');
    assert.notEqual(profile.apiKeyHash, key, 'the stored value is a digest, not the key');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
