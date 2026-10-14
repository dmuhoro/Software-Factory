/**
 * The capability manifest (Sprint 30, WP-1).
 *
 * The manifest exists so the factory cannot describe a capability it does not provide. These cases
 * pin the two rules that make that true — a live claim must name its proof, and a blocked claim
 * must name its owner — plus the tenant-authenticated, read-only route that serves it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-capability-manifest-'));
process.env.FACTORY_DATA_DIR = path.join(state, 'data');
process.env.FACTORY_WORKSPACE_ROOT = path.join(state, 'ws');
process.env.NODE_ENV = 'test';
process.env.FACTORY_API_KEY = 'test-platform-key-0123456789abcdef';
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const {
  CAPABILITIES, buildCapabilityManifest, validateCapabilityManifest, CapabilityManifestError,
} = await import('../src/services/capabilityManifest');
const { DurableStore } = await import('../src/services/durableStore');
const { TenantService } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { apiRouter } = await import('../src/api');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

DurableStore.resetForTests();

function entry(overrides: Record<string, unknown>): Parameters<typeof validateCapabilityManifest>[0][number] {
  return { id: 'x', title: 'X', status: 'live', summary: 'does a thing', proves: 'npm test', ...overrides } as never;
}

// ── the rules ───────────────────────────────────────────────────────────────

test('the shipped manifest validates', () => {
  assert.doesNotThrow(() => validateCapabilityManifest(CAPABILITIES));
  const built = buildCapabilityManifest();
  assert.ok(built.length > 0);
  assert.ok(built.every((item) => item.proves === undefined || typeof item.proves === 'string'));
});

test('a live capability with no named proof is refused', () => {
  const bad = [entry({ id: 'no-proof', proves: undefined })];
  assert.throws(
    () => validateCapabilityManifest(bad),
    (error: unknown) => error instanceof CapabilityManifestError && error.code === 'CAPABILITY_WITHOUT_PROOF',
  );
  assert.throws(() => validateCapabilityManifest([entry({ proves: '   ' })]), /CAPABILITY_WITHOUT_PROOF/);
});

test('a blocked capability with no named owner is refused', () => {
  const bad = [entry({ id: 'blocked-thing', status: 'blocked', proves: undefined, owner: undefined })];
  assert.throws(
    () => validateCapabilityManifest(bad),
    (error: unknown) => error instanceof CapabilityManifestError && error.code === 'CAPABILITY_WITHOUT_OWNER',
  );
});

test('a duplicate id is refused', () => {
  assert.throws(() => validateCapabilityManifest([entry({ id: 'dup' }), entry({ id: 'dup' })]), /CAPABILITY_DUPLICATE_ID/);
});

test('an unknown status is refused', () => {
  assert.throws(() => validateCapabilityManifest([entry({ status: 'maybe' })]), /CAPABILITY_UNKNOWN_STATUS/);
});

test('every live capability in the shipped manifest names a proof', () => {
  for (const capability of CAPABILITIES.filter((item) => item.status === 'live')) {
    assert.ok(capability.proves && capability.proves.trim(), `live capability '${capability.id}' has no proof`);
  }
});

// ── the route ───────────────────────────────────────────────────────────────

test('GET /api/factory/capabilities is 401 without a credential and serves the manifest with one', async () => {
  const TENANT = 'capabilities-tenant';
  TenantService.registerTenant({
    id: TENANT, name: 'Capabilities tenant', niche: IndustryNiche.CUSTOM_B2B,
    tier: TenantSubscriptionTier.PROFESSIONAL, status: TenantStatus.ACTIVE, apiKeyHash: '',
    quota: { maxRequestsPerMinute: 10_000, maxDailyAiTokens: 10_000_000, burstCapacity: 100, storageLimitMb: 1000 },
    customGuardrails: [], encryptionKeyId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const owner = await TenantService.provisionCredential(TENANT);
  resetRateLimiterForTests();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const anonymous = await fetch(`${base}/api/factory/capabilities`);
    assert.equal(anonymous.status, 401, 'the manifest must not be served to an unauthenticated caller');

    const response = await fetch(`${base}/api/factory/capabilities`, { headers: { 'x-api-key': owner.apiKey, 'x-tenant-id': TENANT } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; count: number; capabilities: Array<{ id: string; status: string; proves?: string }> };
    assert.equal(body.status, 'success');
    assert.equal(body.count, CAPABILITIES.length);
    assert.ok(body.capabilities.every((item) => item.status !== 'live' || (item.proves && item.proves.length > 0)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
