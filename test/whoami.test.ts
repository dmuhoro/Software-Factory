/**
 * Sprint 25, phase 8: self-describing authorisation.
 *
 * The rule under test is that a caller can discover what it is allowed to do without
 * being refused first. Discovery by refusal is a support ticket; discovery by asking is
 * a feature. And it answers for the caller only — an endpoint that reported another
 * tenant's posture would be an information leak wearing a helpfully named route.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = `/tmp/opencode/sf-whoami-${process.pid}`;
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;

const TENANT = 'tenant_whoami_0001';
const OTHER = 'tenant_whoami_0002';

const { apiRouter } = await import('../src/api');
const { TenantService } = await import('../src/services/tenantService');
const { RbacService, ANY_RESOURCE } = await import('../src/services/rbacService');
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

registerTenant(TENANT, 'WhoAmI tenant');
registerTenant(OTHER, 'WhoAmI other');
const root = await TenantService.provisionCredential(TENANT);
const otherRoot = await TenantService.provisionCredential(OTHER);

test('the root credential discovers it is root, an admin, and holds everything', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const response = await fetch(`${server.url}/api/whoami`, { headers: auth(root.apiKey, TENANT) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { tenantId: string; role: string; credential: { kind: string }; scopes: string[]; permissions: string[]; enforcementMode: string };

    assert.equal(body.tenantId, TENANT);
    assert.equal(body.credential.kind, 'root');
    assert.equal(body.role, 'admin');
    assert.deepEqual(body.permissions.sort(), ['audit:read', 'credential:provision', 'loop:cancel', 'loop:read', 'loop:submit', 'webhook:manage']);
    assert.deepEqual(body.scopes.sort(), ['admin', 'loop:read', 'loop:write']);
    assert.equal(body.enforcementMode, 'enforce', 'enforce is the default, and the default is what an unset mode reports');
  } finally {
    await server.close();
  }
});

test('a scoped credential discovers it is scoped, a viewer, and holds only loop:read', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const scoped = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 600 });
  try {
    const res = await fetch(`${server.url}/api/whoami`, { headers: auth(scoped.apiKey, TENANT) });
    assert.equal(res.status, 200, 'a scoped credential must be able to ask what it is');
    const body = (await res.json()) as { credential: { kind: string; id: string | null }; role: string; permissions: string[] };
    assert.equal(body.credential.kind, 'scoped');
    assert.equal(body.credential.id, scoped.id);
    assert.equal(body.role, 'viewer', 'a scoped credential is a viewer by default, whatever it was scoped to');
    assert.deepEqual(body.permissions, ['loop:read']);
  } finally {
    await server.close();
  }
});

test('an explicit binding is reported, so a client sees the role it was actually granted', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const scoped = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 600 });
  RbacService.bind(scoped.id, 'auditor', [ANY_RESOURCE]);
  try {
    const body = (await (await fetch(`${server.url}/api/whoami`, { headers: auth(scoped.apiKey, TENANT) })).json()) as { role: string; permissions: string[] };
    assert.equal(body.role, 'auditor');
    assert.deepEqual(body.permissions.sort(), ['audit:read', 'loop:read']);
  } finally {
    RbacService.unbind(scoped.id);
    await server.close();
  }
});

test('whoami answers for the caller and cannot be pointed at another tenant', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    // A credential from tenant A claiming tenant B is refused by the middleware before
    // the route runs, so there is no version of this endpoint that leaks tenant B.
    const mismatched = await fetch(`${server.url}/api/whoami`, { headers: auth(root.apiKey, OTHER) });
    assert.equal(mismatched.status, 403);
    assert.equal(((await mismatched.json()) as { code: string }).code, 'TENANT_CREDENTIAL_MISMATCH');

    // And another tenant's real credential sees only itself.
    const other = (await (await fetch(`${server.url}/api/whoami`, { headers: auth(otherRoot.apiKey, OTHER) })).json()) as { tenantId: string };
    assert.equal(other.tenantId, OTHER);
  } finally {
    await server.close();
  }
});

test('whoami refuses an unauthenticated caller rather than describing an anonymous one', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const anonymous = await fetch(`${server.url}/api/whoami`, { headers: { 'content-type': 'application/json' } });
    assert.equal(anonymous.status, 401);
  } finally {
    await server.close();
  }
});

test('whoami never returns a credential, a digest, or any secret', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const scoped = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 600 });
  try {
    for (const key of [root.apiKey, scoped.apiKey]) {
      const raw = await (await fetch(`${server.url}/api/whoami`, { headers: auth(key, TENANT) })).text();
      assert.ok(!raw.includes(key), 'the response must not echo the presented credential back');
      assert.ok(!raw.includes('sfk_') && !raw.includes('sfs_') && !raw.includes('whsec_'), 'no credential-shaped value may appear');
      assert.ok(!raw.includes('digest') && !raw.includes('scrypt'), 'no digest material may appear');
    }
  } finally {
    await server.close();
  }
});

test('the permission catalogue is the closed set, and is not a capability claim', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const body = (await (await fetch(`${server.url}/api/whoami/permissions`, { headers: auth(root.apiKey, TENANT) })).json()) as { permissions: string[]; note: string };
    assert.deepEqual(body.permissions.sort(), ['audit:read', 'credential:provision', 'loop:cancel', 'loop:read', 'loop:submit', 'webhook:manage']);
    assert.match(body.note, /decided per principal/);
  } finally {
    await server.close();
  }
});
