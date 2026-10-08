/**
 * Sprint 25, phase 3: scoped, expiring tenant credentials.
 *
 * The rule under test is that a scoped credential is strictly narrower than the root
 * credential it hangs off, and that the narrowing is enforced in front of every
 * protected route rather than in a helper some callers remember to use. Every case
 * below drives the real `tenantAuthMiddleware` over HTTP, because a scope check that
 * only runs in a unit test is not a scope check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = `/tmp/opencode/sf-scoped-${process.pid}`;
delete process.env.ALLOW_INSECURE_LOCAL;
delete process.env.FACTORY_TENANT_SEED_DEMO;

const TENANT = 'tenant_scoped_0001';

const { apiRouter } = await import('../src/api');
const { TenantService, ScopedCredentialError } = await import('../src/services/tenantService');
const { resetRateLimiterForTests } = await import('../src/api/middleware/rateLimiter');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');
const { parseScopes, requiredScope, scopeCovers } = await import('../src/utils/scopedCredentials');

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
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function appWithRoutes(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

function auth(key: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': key, 'x-tenant-id': TENANT };
}

registerTenant(TENANT, 'Scoped credentials tenant');
const root = await TenantService.provisionCredential(TENANT);

test('parseScopes refuses an unrecognised scope instead of ignoring it', () => {
  assert.deepEqual(parseScopes(['loop:read']), ['loop:read']);
  assert.deepEqual(parseScopes(['loop:read', 'loop:read']), ['loop:read'], 'duplicates collapse');
  assert.throws(() => parseScopes(['loop:delete']), /not one of/);
  assert.throws(() => parseScopes('loop:read'), /must be an array/);
  assert.deepEqual(parseScopes([]), [], 'an empty grant is valid and grants nothing');
});

test('a protected path nobody enumerated demands admin, so a read scope cannot reach it', () => {
  // The fail-closed half of the design: a route family that is not recognised is
  // treated as admin-only, so adding a route denies every scoped key until someone
  // grants a matching scope on purpose.
  assert.equal(requiredScope('GET', '/api/loop/runs'), 'loop:read');
  assert.equal(requiredScope('POST', '/api/loop/runs'), 'loop:write');
  assert.equal(requiredScope('DELETE', '/api/loop/runs/x/cancel'), 'loop:write');
  assert.equal(requiredScope('GET', '/api/admin/tenants'), 'admin');
  assert.equal(requiredScope('GET', '/api/anything/else'), 'admin');
  assert.equal(requiredScope('GET', '/health'), null, 'public paths need no scope');

  assert.ok(scopeCovers(['admin'], 'loop:write'), 'admin covers everything');
  assert.ok(scopeCovers(['loop:read'], 'loop:read'));
  assert.ok(!scopeCovers(['loop:read'], 'loop:write'));
  assert.ok(!scopeCovers([], 'loop:read'), 'no grant is no access');
});

test('provisioning refuses an empty or unknown scope, and a non-positive TTL', async () => {
  await assert.rejects(() => TenantService.provisionScopedCredential(TENANT, { scopes: [], ttlSeconds: 60 }), /at least one scope/);
  await assert.rejects(() => TenantService.provisionScopedCredential(TENANT, { scopes: ['nope'], ttlSeconds: 60 }), /not one of/);
  await assert.rejects(() => TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 0 }), /positive integer/);
  await assert.rejects(() => TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 1.5 }), /positive integer/);
});

test('a scoped credential authenticates as its tenant and is limited to its scopes', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const issued = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 600 });
  assert.ok(issued.apiKey.startsWith('sfs_'), 'scoped keys are distinguishable from root keys');
  assert.ok(Date.parse(issued.expiresAt) > Date.now());

  try {
    // It authenticates: the tenant context resolves and the route answers rather than 401.
    const list = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, { headers: auth(issued.apiKey) });
    assert.equal(list.status, 200, 'a read-scoped key must be able to read');

    // And it is limited: writing is refused at the boundary, with the scope it lacked.
    const submit = await fetch(`${server.url}/api/loop/runs`, {
      method: 'POST', headers: auth(issued.apiKey),
      body: JSON.stringify({ tenantId: TENANT, repo: 'x', taskDocument: '{}' }),
    });
    assert.equal(submit.status, 403);
    const body = (await submit.json()) as { code: string; message: string };
    assert.equal(body.code, 'CREDENTIAL_SCOPE_INSUFFICIENT');
    assert.match(body.message, /loop:write/);
  } finally {
    await server.close();
  }
});

test('the root credential is not narrowed: it reaches a route a scoped key cannot', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const readOnly = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 600 });

  try {
    const path = '/api/factory/tenants';
    const scoped = await fetch(`${server.url}${path}`, { headers: auth(readOnly.apiKey) });
    assert.equal(scoped.status, 403, 'a read-scoped key is refused an admin route');

    const asRoot = await fetch(`${server.url}${path}`, { headers: auth(root.apiKey) });
    assert.ok(asRoot.status !== 403 && asRoot.status !== 401, `the root credential must not be narrowed, got ${asRoot.status}`);
  } finally {
    await server.close();
  }
});

test('an expired scoped credential is refused with a reason, not a silent miss', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  // ttlSeconds of 1, slept past, so this exercises the real expiry path rather than a
  // hand-edited timestamp.
  const expiring = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read', 'loop:write', 'admin'], ttlSeconds: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1100));

  try {
    const expired = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, { headers: auth(expiring.apiKey) });
    assert.equal(expired.status, 401);
    const body = (await expired.json()) as { code: string };
    assert.equal(body.code, 'SCOPED_CREDENTIAL_EXPIRED');
    await assert.rejects(
      () => TenantService.resolveCredentialOwner(expiring.apiKey),
      (error: unknown) => error instanceof ScopedCredentialError && error.code === 'SCOPED_CREDENTIAL_EXPIRED',
    );
  } finally {
    await server.close();
  }
});

test('revoking one scoped credential leaves the root and the others working', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const keeper = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read', 'loop:write', 'admin'], ttlSeconds: 600 });
  const doomed = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read', 'loop:write', 'admin'], ttlSeconds: 600 });

  try {
    TenantService.revokeScopedCredential(TENANT, doomed.id);

    const revoked = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, { headers: auth(doomed.apiKey) });
    assert.equal(revoked.status, 401);
    assert.equal(((await revoked.json()) as { code: string }).code, 'SCOPED_CREDENTIAL_REVOKED');

    const stillGood = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, { headers: auth(keeper.apiKey) });
    assert.equal(stillGood.status, 200, 'a sibling key must survive a sibling revocation');

    const stillRoot = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, { headers: auth(root.apiKey) });
    assert.equal(stillRoot.status, 200, 'revocation must not touch the root credential');

    // Idempotent: revoking twice is not an error, so a retry cannot fail half-way.
    TenantService.revokeScopedCredential(TENANT, doomed.id);
  } finally {
    await server.close();
  }
});

test('an unknown tenant cannot be given a scoped credential, and one cannot be revoked from it', async () => {
  await assert.rejects(
    () => TenantService.provisionScopedCredential('tenant_nope', { scopes: ['loop:read'], ttlSeconds: 60 }),
    /unknown tenant/,
  );
  // `revokeScopedCredential` is synchronous and persists, so it throws rather than
  // rejects. Asserting rejects here would pass for the wrong reason.
  assert.throws(() => TenantService.revokeScopedCredential('tenant_nope', 'sfc_x'), /unknown tenant/);
  assert.throws(() => TenantService.revokeScopedCredential(TENANT, 'sfc_missing'), /holds no scoped credential/);
});

test('the cancellation route is guarded by the scope check, not beside it', async () => {
  // The point of the phase: the check sits on the real path an operator uses. A key
  // that may read but not write cannot reach the irreversible operation at all.
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  const readOnly = await TenantService.provisionScopedCredential(TENANT, { scopes: ['loop:read'], ttlSeconds: 600 });

  try {
    // Reading the eligibility of a cancellation is a loop read, so a read-scoped key
    // passes the scope check and reaches the handler, which then reports the run is
    // unknown. Refusing that would be wrong: the scope model is about what the key may
    // do, not about hiding which runs exist from a key that is already authorised.
    const eligibility = await fetch(`${server.url}/api/loop/runs/run_missing/cancel`, { headers: auth(readOnly.apiKey) });
    assert.equal(eligibility.status, 404, 'a loop:read key may ask whether a run can be cancelled');

    // Performing it is a loop write, and is refused at the boundary before the handler
    // ever runs.
    const fire = await fetch(`${server.url}/api/loop/runs/run_missing/cancel`, {
      method: 'POST', headers: auth(readOnly.apiKey), body: '{}',
    });
    assert.equal(fire.status, 403);
    assert.equal(((await fire.json()) as { code: string }).code, 'CREDENTIAL_SCOPE_INSUFFICIENT');
  } finally {
    await server.close();
  }
});

test('a key that matches no credential is still a silent miss, not a probe', async () => {
  const server = await listen(appWithRoutes());
  resetRateLimiterForTests();
  try {
    const unknown = await fetch(`${server.url}/api/loop/runs?tenantId=${TENANT}`, {
      headers: auth('sfs_definitely_not_a_real_key_000000000000'),
    });
    assert.equal(unknown.status, 401);
    const body = (await unknown.json()) as { code: string; message: string };
    assert.equal(body.code, 'UNAUTHORIZED', 'a miss must not reveal that scoped credentials exist');
    assert.equal(body.message, 'Valid API credentials are required');
  } finally {
    await server.close();
  }
});
