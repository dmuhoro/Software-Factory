/**
 * Layer 4 regression tests: the tenant registry is durable.
 *
 * The registry used to be a `Map` literal in the source file. That is invisible in a unit
 * test, because a unit test never restarts the process -- the map is simply still there.
 * The consequences were only observable across a restart: every credential handed out
 * stopped verifying, every suspension was forgotten, and the factory's answer to "who is a
 * tenant" existed nowhere but its own heap.
 *
 * These tests therefore do the thing a unit test normally avoids: they throw the process's
 * memory away and read the registry back off disk. `simulateRestart` drops the ledger's
 * in-memory copy and the tenant cache, then rebuilds both from the file, which is exactly
 * the sequence a redeploy performs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-l4-'));
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-l4-ws-'));
delete process.env.FACTORY_TENANT_SEED_DEMO;

const { TenantService } = await import('../src/services/tenantService');
const { DurableStore, LEDGER_VERSION, MIN_LEDGER_VERSION } = await import('../src/services/durableStore');
const { IndustryNiche, TenantStatus, TenantSubscriptionTier } = await import('../src/models/tenant');

const LEDGER_FILE = path.join(DATA_DIR, 'software-factory.json');

type Niche = (typeof IndustryNiche)[keyof typeof IndustryNiche];

function seedTenant(id: string, niche: Niche = IndustryNiche.CUSTOM_B2B): void {
  TenantService.registerTenant({
    id,
    name: `L4 durable ${id}`,
    niche,
    tier: TenantSubscriptionTier.PROFESSIONAL,
    status: TenantStatus.ACTIVE,
    apiKeyHash: '',
    quota: { maxRequestsPerMinute: 5, maxDailyAiTokens: 1000, burstCapacity: 2, storageLimitMb: 10 },
    customGuardrails: [],
    encryptionKeyId: 'test-key',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
}

/**
 * Discards every in-memory copy and rebuilds from disk, which is what a restart does.
 * The ledger file is untouched, so anything that only lived in memory is now gone.
 */
function simulateRestart(): void {
  DurableStore.resetForTests();
  TenantService.resetCacheForTests();
  TenantService.bootstrap();
}

function readLedger(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as Record<string, unknown>;
}

function readLedgerIn(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'software-factory.json'), 'utf8')) as Record<string, unknown>;
}

function freshProfile(id: string) {
  return {
    id,
    name: `L4 profile ${id}`,
    niche: IndustryNiche.CUSTOM_B2B as Niche,
    tier: TenantSubscriptionTier.PROFESSIONAL as (typeof TenantSubscriptionTier)[keyof typeof TenantSubscriptionTier],
    status: TenantStatus.ACTIVE as (typeof TenantStatus)[keyof typeof TenantStatus],
    apiKeyHash: '',
    quota: { maxRequestsPerMinute: 5, maxDailyAiTokens: 1000, burstCapacity: 2, storageLimitMb: 10 },
    customGuardrails: [],
    encryptionKeyId: 'test-key',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

/**
 * Runs a case against a ledger of its own.
 *
 * Several cases below deliberately write a record that must abort the load. Against the
 * shared directory that record would still be there for the next case, so each one would
 * fail on its predecessor's corruption rather than its own -- a suite that looks broken for
 * the wrong reason and hides which check is actually working. `DurableStore.dataFile()`
 * reads the directory from the environment on every access, so switching the variable is a
 * genuine isolation boundary rather than a reset of shared state.
 */
function withIsolatedLedger(run: (dir: string) => void, cleanup?: () => void): void {
  const previousDir = process.env.FACTORY_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-l4-iso-'));
  DurableStore.resetForTests();
  TenantService.resetCacheForTests();
  process.env.FACTORY_DATA_DIR = dir;
  try {
    run(dir);
  } finally {
    cleanup?.();
    DurableStore.resetForTests();
    TenantService.resetCacheForTests();
    process.env.FACTORY_DATA_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('L4: a provisioned credential still authenticates after a restart', async () => {
  const TENANT = 'tenant_l4_durable';
  seedTenant(TENANT);
  const issued = await TenantService.provisionCredential(TENANT);

  assert.ok(await TenantService.resolveCredentialOwner(issued.apiKey), 'precondition: the credential resolves before the restart');

  simulateRestart();

  const owner = await TenantService.resolveCredentialOwner(issued.apiKey);
  assert.equal(owner?.tenantId, TENANT, 'the digest must be read back from the ledger, not from the old heap');
});

test('L4: a suspended tenant stays suspended after a restart', async () => {
  const TENANT = 'tenant_l4_suspend';
  seedTenant(TENANT, IndustryNiche.HEALTHCARE);
  const issued = await TenantService.provisionCredential(TENANT);

  const profile = TenantService.getTenant(TENANT);
  assert.ok(profile);
  TenantService.registerTenant({ ...profile, status: TenantStatus.SUSPENDED });

  simulateRestart();

  const restored = TenantService.getTenant(TENANT);
  assert.equal(restored?.status, TenantStatus.SUSPENDED, 'a suspension forgotten on restart is a tenant silently reinstated');
  assert.equal(await TenantService.resolveCredentialOwner(issued.apiKey), undefined, 'a suspended tenant must not authenticate');
});

test('L4: a revocation survives a restart instead of resurrecting the credential', async () => {
  const TENANT = 'tenant_l4_revoke';
  seedTenant(TENANT, IndustryNiche.LOGISTICS);
  const issued = await TenantService.provisionCredential(TENANT);
  assert.ok(await TenantService.resolveCredentialOwner(issued.apiKey), 'precondition: the credential resolves before revocation');

  TenantService.revokeCredential(TENANT);
  assert.equal(await TenantService.resolveCredentialOwner(issued.apiKey), undefined, 'precondition: the credential is refused straight after revocation');

  simulateRestart();

  assert.equal(
    await TenantService.resolveCredentialOwner(issued.apiKey),
    undefined,
    'a revoked credential must not come back when the process restarts',
  );
  assert.equal(TenantService.getTenant(TENANT)?.apiKeyHash, '', 'the digest must be cleared on disk, not just in memory');
});

test('L4: revoking a tenant that does not exist is refused, not silently ignored', () => {
  // Silently returning would let an operator believe a credential was revoked.
  assert.throws(() => TenantService.revokeCredential('tenant_l4_never_existed'), /unknown tenant/);
});

test('L4: the plaintext credential never reaches the ledger', async () => {
  const TENANT = 'tenant_l4_no_plaintext';
  seedTenant(TENANT);
  // A distinctive marker, so a substring match for a real secret cannot be a false negative.
  const plaintext = 'PLAINTEXT-MUST-NEVER-BE-PERSISTED-0001';
  await TenantService.provisionCredential(TENANT, plaintext);
  const apiKeyHash = TenantService.getTenant(TENANT)?.apiKeyHash ?? '';
  assert.ok(apiKeyHash.startsWith('scrypt$'), 'precondition: a digest was produced');

  const serialised = fs.readFileSync(LEDGER_FILE, 'utf8');
  // The digest MUST be there first. Without this the assertion below would also pass if
  // the credential were never persisted at all -- a test that cannot fail is decoration,
  // and a "no plaintext on disk" claim that survives the ledger being empty proves nothing.
  assert.ok(serialised.includes(apiKeyHash), 'the digest must be persisted, or this test asserts nothing');
  assert.ok(!serialised.includes(plaintext), 'the tenant credential must be stored only as a digest');
  assert.ok(!serialised.includes('PLAINTEXT-MUST-NEVER-BE-PERSISTED'), 'no fragment of the plaintext may be written either');
});

test('L4: a durable registry is the source of truth, not a cache over a map literal', () => {
  seedTenant('tenant_l4_truth');
  simulateRestart();
  // Nothing in this test re-registered the tenant after the restart. If the registry were
  // still a literal in the source file, this id would be unknown right now.
  assert.ok(TenantService.getTenant('tenant_l4_truth'), 'the registry must be readable from the ledger alone');
  assert.ok(readLedger().tenants, 'tenants must be a first-class ledger collection');
});

test('L4: a tenant record with an unknown niche aborts the load rather than being coerced', () => {
  withIsolatedLedger(() => {
    // Write directly, bypassing the validating path, exactly as a damaged or hand-edited
    // ledger would contain it.
    DurableStore.upsert('tenants', 'tenant_l4_corrupt_niche', { ...freshProfile('tenant_l4_corrupt_niche'), niche: 'aerial_surveying' });
    // The message must name the offending value, not only the allowed set, or an operator
    // has to open the file to learn which record is broken.
    assert.throws(() => TenantService.bootstrap(), /niche 'aerial_surveying' is not one of/);
  });
});

test('L4: a tenant record with a non-positive quota aborts the load', () => {
  withIsolatedLedger(() => {
    const base = freshProfile('tenant_l4_corrupt_quota');
    DurableStore.upsert('tenants', 'tenant_l4_corrupt_quota', { ...base, quota: { ...base.quota, maxRequestsPerMinute: 0 } });
    assert.throws(() => TenantService.bootstrap(), /maxRequestsPerMinute must be a positive integer/);
  });
});

test('L4: a legacy placeholder digest in a persisted record is refused at load', () => {
  // A registry written by an older build could hold `hash_re_sec_49182a938`. Reading it back
  // without validation would make a published placeholder into a storable credential value.
  withIsolatedLedger(() => {
    const id = 'tenant_l4_placeholder';
    DurableStore.upsert('tenants', id, { ...freshProfile(id), apiKeyHash: 'hash_re_sec_49182a938' });
    assert.throws(() => TenantService.bootstrap(), /neither empty nor a valid scrypt digest/);
  });
});

test('L4: a record whose id disagrees with its key aborts the load', () => {
  withIsolatedLedger(() => {
    const id = 'tenant_l4_mismatch';
    DurableStore.upsert('tenants', id, { ...freshProfile(id), id: 'tenant_l4_somewhere_else' });
    assert.throws(() => TenantService.bootstrap(), /does not match its record key/);
  });
});

test('L4: demo tenants are absent unless explicitly requested', () => {
  // bootstrap() has run in every earlier test with the flag unset. If the seed were
  // unconditional, these three fabricated records would already be in the ledger.
  const registered = TenantService.listTenants().map((t) => t.id);
  assert.ok(!registered.includes('tenant_re_8841'), 'demo tenants must not be installed by default');
  assert.ok(!registered.includes('tenant_hc_1042'), 'demo tenants must not be installed by default');
  assert.ok(!registered.includes('tenant_log_5529'), 'demo tenants must not be installed by default');
});

test('L4: demo tenants are installed on explicit opt-in into an empty registry', () => {
  withIsolatedLedger(() => {
    assert.equal(TenantService.listTenants().length, 0, 'precondition: the registry is empty');
    process.env.FACTORY_TENANT_SEED_DEMO = 'true';
    TenantService.bootstrap();
    const registered = TenantService.listTenants().map((t) => t.id);
    assert.equal(registered.length, 3);
    for (const id of ['tenant_re_8841', 'tenant_hc_1042', 'tenant_log_5529']) {
      assert.ok(registered.includes(id), `${id} must be installed when the operator asks for it`);
    }
    // And they are real records now, not a map literal: a restart must find them on disk.
    assert.equal(Object.keys((readLedgerIn(process.env.FACTORY_DATA_DIR as string).tenants as object)).length, 3);
  }, () => { delete process.env.FACTORY_TENANT_SEED_DEMO; });
});

test('L4: demo tenants are not re-seeded over a registry that already has tenants', () => {
  withIsolatedLedger(() => {
    TenantService.registerTenant(freshProfile('tenant_l4_real_customer'));
    process.env.FACTORY_TENANT_SEED_DEMO = 'true';
    TenantService.bootstrap();
    const registered = TenantService.listTenants().map((t) => t.id);
    assert.deepEqual(registered, ['tenant_l4_real_customer'], 'seeding must not overwrite a populated registry');
  }, () => { delete process.env.FACTORY_TENANT_SEED_DEMO; });
});

test('L4: a version-4 ledger is migrated forward and loses nothing', () => {
  // The tenants collection was added in version 5. Refusing v4 would have routed every
  // existing deployment through the corrupt-document recovery path, which quarantines the
  // live ledger and resets it: the schema change would have destroyed the data it was
  // meant to preserve. This asserts the migration preserves existing records.
  withIsolatedLedger((dir) => {
    fs.writeFileSync(path.join(dir, 'software-factory.json'), JSON.stringify({
      version: 4,
      telemetry: { 'doc_keep_me': { tenantId: 'tenant_v4', payload: { k: 'v' } } },
      audits: [{ tenantId: 'tenant_v4', note: 'pre-migration' }],
    }));
    assert.equal(DurableStore.get('telemetry', 'doc_keep_me')?.tenantId, 'tenant_v4', 'a v4 record must still be readable');
    assert.equal(DurableStore.audits('tenant_v4').length, 1, 'the audit log must survive the migration');
    assert.equal(readLedgerIn(dir).version, LEDGER_VERSION, 'the document must be rewritten at the current version');
    assert.deepEqual(readLedgerIn(dir).tenants, {}, 'the new collection must start empty, not absent');
  });
});

test('L4: a ledger written by a newer build is refused instead of being coerced', () => {
  withIsolatedLedger((dir) => {
    fs.writeFileSync(path.join(dir, 'software-factory.json'), JSON.stringify({
      version: LEDGER_VERSION + 1,
      telemetry: { doc_future: { tenantId: 'tenant_future' } },
    }));
    // This build cannot know what a future build added, so reading it would mean silently
    // discarding whatever that build wrote. It is quarantined, and health reports the loss
    // rather than pretending the ledger was clean.
    assert.equal(DurableStore.get('telemetry', 'doc_future'), undefined, 'a future document must not be half-read');
    assert.equal(DurableStore.lastRecovery()?.recordsLost, true, 'the loss must be reported, not hidden');
  });
});
