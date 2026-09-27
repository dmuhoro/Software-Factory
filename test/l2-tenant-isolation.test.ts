/**
 * Layer 2 regression tests: tenant isolation and quota enforcement.
 *
 * The Phase 1 audit proved that one leaked `FACTORY_API_KEY` granted every tenant's
 * data, because authentication compared the caller's key against that single global
 * value and then believed whatever `X-Tenant-Id` header followed. `TenantProfile` even
 * declared an `apiKeyHash` that nothing ever verified.
 *
 * These tests pin the replacement: a credential resolves to exactly one partition, a
 * claim for any other tenant is refused from every claim source, and the rate limiter
 * is keyed on the authenticated identity rather than on caller-supplied input.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-l2-'));
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-l2-ws-'));

const { TenantService } = await import('../src/services/tenantService');
const { hashTenantCredential, verifyTenantCredential, isCredentialDigest } = await import('../src/utils/tenantCredentials');
const { resetRateLimiterForTests, tenantRateLimiter } = await import('../src/api/middleware/rateLimiter');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

const ALICE = 'tenant_l2_alice';
const BOB = 'tenant_l2_bob';

function seedTenant(id: string, niche: (typeof IndustryNiche)[keyof typeof IndustryNiche]): void {
  TenantService.registerTenant({
    id,
    name: `L2 test ${id}`,
    niche,
    tier: TenantSubscriptionTier.PROFESSIONAL,
    status: TenantStatus.ACTIVE,
    apiKeyHash: '',
    quota: { maxRequestsPerMinute: 5, maxDailyAiTokens: 1000, burstCapacity: 2, storageLimitMb: 10 },
    customGuardrails: [],
    encryptionKeyId: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

test('L2: a seeded tenant with no credential digest is inert, not open', () => {
  seedTenant('tenant_l2_unprovisioned', IndustryNiche.CUSTOM_B2B);
  // A registry entry must never be usable as a credential by itself.
  assert.equal(TenantService.getTenant('tenant_l2_unprovisioned')?.apiKeyHash, '');
  assert.equal(isCredentialDigest(''), false);
  assert.equal(isCredentialDigest('hash_re_sec_49182a938'), false, 'legacy placeholder hashes must not verify');
  assert.equal(isCredentialDigest(undefined), false);
});

test('L2: a credential resolves to exactly one tenant, and only that tenant', async () => {
  seedTenant(ALICE, IndustryNiche.HEALTHCARE);
  seedTenant(BOB, IndustryNiche.LOGISTICS);
  const alice = await TenantService.provisionCredential(ALICE);
  const bob = await TenantService.provisionCredential(BOB);
  assert.notEqual(alice.apiKey, bob.apiKey);

  const owner = await TenantService.resolveCredentialOwner(alice.apiKey);
  assert.equal(owner?.tenantId, ALICE);
  assert.equal((await TenantService.resolveCredentialOwner(bob.apiKey))?.tenantId, BOB);

  // Alice's key must not resolve to Bob under any circumstances.
  assert.notEqual((await TenantService.resolveCredentialOwner(alice.apiKey))?.tenantId, BOB);
  assert.equal(await TenantService.resolveCredentialOwner('sfk_not_a_real_credential_at_all'), undefined);
  assert.equal(await TenantService.resolveCredentialOwner(''), undefined);
});

test('L2: credentials are stored only as salted digests, never in plaintext', async () => {
  seedTenant('tenant_l2_digest', IndustryNiche.REAL_ESTATE);
  const issued = await TenantService.provisionCredential('tenant_l2_digest');
  const stored = TenantService.getTenant('tenant_l2_digest')?.apiKeyHash ?? '';

  assert.ok(isCredentialDigest(stored), 'the stored value must be a scrypt digest');
  assert.ok(!stored.includes(issued.apiKey), 'the plaintext must not appear in the digest');
  assert.ok(await verifyTenantCredential(issued.apiKey, stored));
  assert.equal(await verifyTenantCredential(`${issued.apiKey}x`, stored), false);
});

test('L2: credential verification is constant-time safe and rejects tampered parameters', async () => {
  const digest = await hashTenantCredential('a-sufficiently-long-credential');
  assert.equal(await verifyTenantCredential('a-sufficiently-long-credential', digest), true);
  assert.equal(await verifyTenantCredential('a-sufficiently-long-credentiaL', digest), false);
  // A tampered record must not be able to force a huge allocation.
  const tampered = digest.replace(/^scrypt\$\d+\$/, 'scrypt$99999999$');
  assert.equal(await verifyTenantCredential('a-sufficiently-long-credential', tampered), false);
  assert.equal(await verifyTenantCredential('a-sufficiently-long-credential', 'garbage'), false);
  assert.equal(await verifyTenantCredential('a-sufficiently-long-credential', ''), false);
});

test('L2: a revoked credential stops authenticating immediately', async () => {
  seedTenant('tenant_l2_revoke', IndustryNiche.CUSTOM_B2B);
  const issued = await TenantService.provisionCredential('tenant_l2_revoke');
  assert.ok(await TenantService.resolveCredentialOwner(issued.apiKey));
  TenantService.revokeCredential('tenant_l2_revoke');
  assert.equal(await TenantService.resolveCredentialOwner(issued.apiKey), undefined);
});

test('L2: a suspended tenant cannot authenticate even with a valid credential', async () => {
  seedTenant('tenant_l2_suspended', IndustryNiche.CUSTOM_B2B);
  const issued = await TenantService.provisionCredential('tenant_l2_suspended');
  const profile = TenantService.getTenant('tenant_l2_suspended');
  TenantService.registerTenant({ ...(profile as NonNullable<typeof profile>), status: TenantStatus.SUSPENDED });
  assert.equal(await TenantService.resolveCredentialOwner(issued.apiKey), undefined);
});

test('L2: the rate limiter refuses to run without an authenticated principal', () => {
  resetRateLimiterForTests();
  const captured: Array<{ status: number; body: unknown }> = [];
  const res = {
    setHeader() { return res; },
    status(code: number) { captured.push({ status: code, body: undefined }); return res; },
    json(body: unknown) { captured[0] = { status: captured[0]?.status ?? 0, body }; return res; },
  } as never;
  let nextCalled = false;
  tenantRateLimiter({ headers: {}, body: {}, query: {} } as never, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'an unauthenticated request must never reach the handler');
  assert.equal(captured[0]?.status, 401);
});

test('L2: the rate limiter keys on the principal, so rotating a header cannot evade it', async () => {
  seedTenant('tenant_l2_limited', IndustryNiche.CUSTOM_B2B);
  resetRateLimiterForTests();
  const statusFor = (tenantId: string) => {
    const captured: number[] = [];
    const res = {
      setHeader() { return res; },
      status(code: number) { captured.push(code); return res; },
      json() { return res; },
    } as never;
    tenantRateLimiter(
      // The caller lies in the header on every request; the principal does not change.
      { headers: { 'x-tenant-id': `spoofed-${Math.random()}` }, body: {}, query: {}, principal: { tenantId, role: 'tenant_operator' } } as never,
      res,
      () => captured.push(200),
    );
    return captured[0];
  };

  // burstCapacity is 2 for this tenant, so the third request must be refused.
  assert.equal(statusFor('tenant_l2_limited'), 200);
  assert.equal(statusFor('tenant_l2_limited'), 200);
  assert.equal(statusFor('tenant_l2_limited'), 429, 'spoofed headers must not reset the bucket');
  // A different tenant has its own bucket and is unaffected.
  assert.equal(statusFor(ALICE), 200);
});

test('L2: the rate limiter applies the tenant\'s declared quota, not a hardcoded one', async () => {
  seedTenant('tenant_l2_quota', IndustryNiche.CUSTOM_B2B);
  const profile = TenantService.getTenant('tenant_l2_quota');
  TenantService.registerTenant({
    ...(profile as NonNullable<typeof profile>),
    quota: { maxRequestsPerMinute: 1, maxDailyAiTokens: 10, burstCapacity: 1, storageLimitMb: 1 },
  });
  resetRateLimiterForTests();
  const seen: Record<string, string | undefined> = {};
  const res = { setHeader(k: string, v: string) { seen[k] = v; return res; }, status() { return res; }, json() { return res; } } as never;
  tenantRateLimiter({ headers: {}, body: {}, query: {}, principal: { tenantId: 'tenant_l2_quota', role: 'tenant_operator' } } as never, res, () => { seen.next = 'yes'; });
  assert.equal(seen['X-RateLimit-Limit'], '1', 'the reported limit must be the tenant tier quota');
});

test('L2: configuration refuses placeholder or malformed tenant credentials', async () => {
  const { resolveRuntimeConfig, errorsOf } = await import('../src/configurations/runtimeConfig');

  const placeholder = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    FACTORY_TENANT_CREDENTIALS: `${ALICE}:replace-with-provider-secret`,
  } as NodeJS.ProcessEnv);
  assert.ok(errorsOf(placeholder).some((issue) => /placeholder credential/.test(issue.message)));

  const malformed = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    FACTORY_TENANT_CREDENTIALS: 'no-separator-here',
  } as NodeJS.ProcessEnv);
  assert.ok(errorsOf(malformed).some((issue) => /Malformed tenant credential/.test(issue.message)));

  const short = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    FACTORY_TENANT_CREDENTIALS: `${ALICE}:tooshort`,
  } as NodeJS.ProcessEnv);
  assert.ok(errorsOf(short).some((issue) => /at least 24 characters/.test(issue.message)));

  const good = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    FACTORY_TENANT_CREDENTIALS: `${ALICE}:a-sufficiently-long-credential`,
  } as NodeJS.ProcessEnv);
  assert.equal(errorsOf(good).length, 0);
  assert.equal(Object.keys(good.tenantCredentials).length, 1);
});

test('L2: the startup banner never prints a credential value', async () => {
  const { resolveRuntimeConfig, describeConfig } = await import('../src/configurations/runtimeConfig');
  const secret = 'a-very-secret-tenant-credential-value';
  const config = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FACTORY_API_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    FACTORY_TENANT_CREDENTIALS: `${ALICE}:${secret}`,
  } as NodeJS.ProcessEnv);
  const banner = describeConfig(config);
  assert.ok(!banner.includes(secret), 'a credential must never reach a log line');
  assert.ok(banner.includes('1 provisioned'));
});
