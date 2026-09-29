/**
 * Tenant Governance and Isolation Service
 * Enforces zero-conflation memory boundaries and validates partition ownership.
 *
 * ## Durability
 *
 * The registry used to be a module-level `Map` literal. That made every provisioned
 * credential, and every suspension, evaporate on restart, and it meant the process's idea
 * of "who is a tenant" existed nowhere outside its own heap. AfroPay's first invariant --
 * in-memory structures are never a system of record -- is correct, and this module is now
 * built to it: the durable ledger is the system of record and the `Map` is only a cache of
 * it, populated by `bootstrap()` before the port is bound and written through on every
 * mutation.
 *
 * The cache is a cache and nothing more. A reader that trusted it without the store behind
 * it would be a second source of truth, which is the defect this change removes.
 *
 * ## Decoding
 *
 * Records read back from the ledger are validated, not coerced. A field carrying an
 * unknown enum value, a non-positive quota, or a missing identity is a corrupted registry,
 * and a registry that cannot be trusted must not be silently repaired into one that looks
 * fine -- that is how a tenant ends up active when nobody provisioned it.
 */

import { IndustryNiche, TenantProfile, TenantQuota, TenantSubscriptionTier, TenantStatus, TenantContext } from '../models/tenant';
import { SUBSCRIPTION_QUOTAS } from '../configurations/factory.config';
import { DurableStore } from './durableStore';
import { emitMalformedContextError, emitSecurityError } from '../utils/validation';
import { hashTenantCredential, isCredentialDigest, verifyTenantCredential } from '../utils/tenantCredentials';
import { randomBytes } from 'node:crypto';

/** Ledger collection holding the tenant registry. */
const COLLECTION = 'tenants' as const;

/**
 * In-memory cache of the durable registry. Never read as a source of truth on its own.
 */
const TENANT_REGISTRY = new Map<string, TenantProfile>();

const NICHE_VALUES = new Set<string>(Object.values(IndustryNiche));
const TIER_VALUES = new Set<string>(Object.values(TenantSubscriptionTier));
const STATUS_VALUES = new Set<string>(Object.values(TenantStatus));
const QUOTA_FIELDS = ['maxRequestsPerMinute', 'maxDailyAiTokens', 'burstCapacity', 'storageLimitMb'] as const;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Rebuilds a `TenantProfile` from a stored record, or throws.
 *
 * Throwing is the point. `hydrate` in the store coerces a damaged document, which is right
 * for a telemetry row and wrong for an identity record: coercing a bad niche to `undefined`
 * would let a request match no niche and reach the adapter layer, so a corrupt registry
 * must abort startup instead.
 */
function decodeProfile(record: Record<string, unknown>, key: string): TenantProfile {
  const where = `tenant record '${key}'`;

  const id = record.id;
  if (typeof id !== 'string' || id === '') throw new Error(`${where}: id must be a non-empty string`);
  if (id !== key) throw new Error(`${where}: id '${id}' does not match its record key`);

  const name = record.name;
  if (typeof name !== 'string' || name.trim() === '') throw new Error(`${where}: name must be a non-empty string`);

  const niche = record.niche;
  if (typeof niche !== 'string' || !NICHE_VALUES.has(niche)) {
    // Name the value that was found, not just the ones that are allowed. "niche must be one
    // of ..." tells an operator they have a problem; "niche is 'aerial_surveying'" tells
    // them which record to open.
    throw new Error(`${where}: niche '${String(niche)}' is not one of ${[...NICHE_VALUES].join(', ')}`);
  }

  const tier = record.tier;
  if (typeof tier !== 'string' || !TIER_VALUES.has(tier)) {
    throw new Error(`${where}: tier '${String(tier)}' is not one of ${[...TIER_VALUES].join(', ')}`);
  }

  const status = record.status;
  if (typeof status !== 'string' || !STATUS_VALUES.has(status)) {
    throw new Error(`${where}: status '${String(status)}' is not one of ${[...STATUS_VALUES].join(', ')}`);
  }

  // An absent or malformed digest is legitimate: a tenant may be provisioned but hold no
  // credential. A present one must be a real digest, so a legacy placeholder cannot
  // masquerade as a usable credential in a persisted record.
  const apiKeyHash = record.apiKeyHash;
  if (apiKeyHash !== '' && !isCredentialDigest(apiKeyHash)) {
    throw new Error(`${where}: apiKeyHash is neither empty nor a valid scrypt digest`);
  }

  const quota = record.quota;
  if (typeof quota !== 'object' || quota === null || Array.isArray(quota)) {
    throw new Error(`${where}: quota must be an object`);
  }
  const quotaSource = quota as Record<string, unknown>;
  for (const field of QUOTA_FIELDS) {
    if (!isPositiveInteger(quotaSource[field])) {
      throw new Error(`${where}: quota.${field} must be a positive integer`);
    }
  }

  const customGuardrails = record.customGuardrails;
  if (!Array.isArray(customGuardrails) || customGuardrails.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${where}: customGuardrails must be an array of strings`);
  }

  const encryptionKeyId = record.encryptionKeyId;
  if (typeof encryptionKeyId !== 'string' || encryptionKeyId.trim() === '') {
    throw new Error(`${where}: encryptionKeyId must be a non-empty string`);
  }

  const createdAt = record.createdAt;
  const updatedAt = record.updatedAt;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`${where}: createdAt must be an ISO-8601 timestamp`);
  }
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error(`${where}: updatedAt must be an ISO-8601 timestamp`);
  }

  return {
    id,
    name,
    niche: niche as IndustryNiche,
    tier: tier as TenantSubscriptionTier,
    status: status as TenantStatus,
    apiKeyHash,
    quota: {
      maxRequestsPerMinute: quotaSource.maxRequestsPerMinute as number,
      maxDailyAiTokens: quotaSource.maxDailyAiTokens as number,
      burstCapacity: quotaSource.burstCapacity as number,
      storageLimitMb: quotaSource.storageLimitMb as number,
    },
    customGuardrails: [...(customGuardrails as string[])],
    encryptionKeyId,
    createdAt,
    updatedAt,
  };
}

function encodeProfile(profile: TenantProfile): Record<string, unknown> {
  return { ...profile, quota: { ...profile.quota }, customGuardrails: [...profile.customGuardrails] };
}

/**
 * Writes the demo tenants into a registry that has none, and says so out loud.
 *
 * Audibly, because the alternative is an operator who cannot tell three invented customers
 * from real ones. A silent install of fabricated records is indistinguishable from a
 * successful onboarding, which is the exact confusion the records' names mark them to
 * prevent.
 */
function seedDemoTenants(): void {
  for (const profile of DEMO_TENANTS) DurableStore.upsert(COLLECTION, profile.id, encodeProfile(profile));
  // eslint-disable-next-line no-console -- an operator must see that fabricated records entered their ledger
  console.warn(`[Software Factory] installed ${DEMO_TENANTS.length} DEMO tenant(s) into an empty registry (FACTORY_TENANT_SEED_DEMO=true). These are fabricated records, not customers.`);
}

/**
 * Demo tenants, installed only on an explicit opt-in and only into an empty registry.
 *
 * These are fabricated records -- invented company names and invented key identifiers. They
 * exist so the UI and the verification harnesses have partitions to work with, and they are
 * marked as demo for that reason. A deployment that is not asked for them gets an empty
 * registry, which is the correct state for a factory that has not onboarded anyone yet, and
 * an empty registry refuses every tenant route rather than inventing three customers.
 */
const DEMO_TENANTS: readonly TenantProfile[] = [
  {
    id: 'tenant_re_8841',
    name: 'DEMO Apex Residential Realty',
    niche: IndustryNiche.REAL_ESTATE,
    tier: TenantSubscriptionTier.ENTERPRISE,
    status: TenantStatus.ACTIVE,
    apiKeyHash: '',
    quota: SUBSCRIPTION_QUOTAS[TenantSubscriptionTier.ENTERPRISE],
    customGuardrails: ['RESPA_COMPLIANCE', 'FAIR_HOUSING_STRICT'],
    encryptionKeyId: 'demo-key/re-tenant',
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'tenant_hc_1042',
    name: 'DEMO Vanguard Health Systems',
    niche: IndustryNiche.HEALTHCARE,
    tier: TenantSubscriptionTier.ENTERPRISE,
    status: TenantStatus.ACTIVE,
    apiKeyHash: '',
    quota: SUBSCRIPTION_QUOTAS[TenantSubscriptionTier.ENTERPRISE],
    customGuardrails: ['HIPAA_SAFE_HARBOR_18', 'HL7_FHIR_V4_STRICT'],
    encryptionKeyId: 'demo-key/hc-tenant',
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  },
  {
    id: 'tenant_log_5529',
    name: 'DEMO TransContinental Freight & ColdChain',
    niche: IndustryNiche.LOGISTICS,
    tier: TenantSubscriptionTier.PROFESSIONAL,
    status: TenantStatus.ACTIVE,
    apiKeyHash: '',
    quota: SUBSCRIPTION_QUOTAS[TenantSubscriptionTier.PROFESSIONAL],
    customGuardrails: ['IATA_DANGEROUS_GOODS', 'REEFER_TEMP_MONITOR'],
    encryptionKeyId: 'demo-key/log-tenant',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  },
];

export class TenantService {
  /**
   * Loads the registry from the durable ledger and fills the cache.
   *
   * Must run before the port is bound. A tenant must never be told it is unknown because a
   * restart had not finished loading, and a registry that fails to load must abort startup
   * rather than leave the cache empty -- an empty cache with a healthy process would make
   * every provisioned tenant look deleted, which is indistinguishable from an outage and
   * is far harder to diagnose than a refused start.
   */
  public static bootstrap(): void {
    const records = DurableStore.entries(COLLECTION);
    if (records.length === 0 && process.env.FACTORY_TENANT_SEED_DEMO === 'true') {
      seedDemoTenants();
    }
    const loaded = DurableStore.entries(COLLECTION);
    TENANT_REGISTRY.clear();
    for (const [key, record] of loaded) {
      // The KEY is the record's real identity. Validating against record.id instead would
      // compare the id to itself and accept a record filed under the wrong id.
      TENANT_REGISTRY.set(key, decodeProfile(record, key));
    }
  }

  /**
   * Resolves and verifies tenant context against partitioned credentials.
   * Enforces zero conflation: verifies that requested niche matches registered tenant vertical.
   */
  public static resolveContext(tenantId: string, requestedNiche: IndustryNiche, correlationId: string): { context?: TenantContext; error?: unknown } {
    const profile = TENANT_REGISTRY.get(tenantId);

    if (!profile) {
      return {
        error: emitSecurityError('TENANT_NOT_FOUND', `Tenant '${tenantId}' is not registered in the Software Factory`),
      };
    }

    if (profile.status !== TenantStatus.ACTIVE) {
      return {
        error: emitSecurityError('TENANT_SUSPENDED', `Tenant '${tenantId}' is currently ${profile.status}`),
      };
    }

    // Zero-conflation rule: tenant cannot claim or process another tenant's niche
    if (profile.niche !== requestedNiche) {
      return {
        error: emitMalformedContextError(
          `Tenant '${tenantId}' is provisioned exclusively for '${profile.niche}' but requested '${requestedNiche}'. Cross-niche conflation rejected.`
        ),
      };
    }

    const context: TenantContext = {
      tenantId: profile.id,
      niche: profile.niche,
      tier: profile.tier,
      correlationId,
      authenticatedRole: 'tenant_operator',
      quota: profile.quota,
    };

    return { context };
  }

  /**
   * Resolves a presented credential to the ONE tenant that owns it.
   *
   * This is the boundary that makes tenant isolation real. Previously nothing verified
   * `apiKeyHash`, so any caller holding the single global key could assert any tenant
   * id. A credential now resolves to exactly one partition, and a mismatch between the
   * credential's owner and the claimed tenant is refused rather than reconciled.
   *
   * Returns undefined when the credential matches no active tenant. Comparison is
   * constant-time per candidate and every active tenant is examined, so the response
   * time does not reveal which prefix matched.
   */
  public static async resolveCredentialOwner(presented: string): Promise<{ tenantId: string; profile: TenantProfile } | undefined> {
    if (typeof presented !== 'string' || presented.length === 0) return undefined;
    let owner: { tenantId: string; profile: TenantProfile } | undefined;
    for (const profile of TENANT_REGISTRY.values()) {
      if (profile.status !== TenantStatus.ACTIVE) continue;
      // A tenant without a valid digest is inert, not open. Provisioned-but-credential-less
      // records therefore cannot be used to authenticate.
      if (!isCredentialDigest(profile.apiKeyHash)) continue;
      if (await verifyTenantCredential(presented, profile.apiKeyHash)) owner = { tenantId: profile.id, profile };
    }
    return owner;
  }

  /**
   * Issues a credential for a tenant, storing only its digest.
   *
   * The digest is written through to the ledger before this resolves, so a crash between
   * issuing and a later restart cannot leave an operator believing a credential was handed
   * out when the registry never learned of it. Returns the plaintext exactly once; it is
   * not recoverable afterwards.
   */
  public static async provisionCredential(tenantId: string, plaintext?: string): Promise<{ tenantId: string; apiKey: string }> {
    const profile = TENANT_REGISTRY.get(tenantId);
    if (!profile) throw new Error(`Cannot provision a credential for unknown tenant '${tenantId}'`);
    const apiKey = plaintext ?? `sfk_${randomBytes(24).toString('base64url')}`;
    const digest = await hashTenantCredential(apiKey);
    this.persist({ ...profile, apiKeyHash: digest, updatedAt: new Date().toISOString() });
    return { tenantId, apiKey };
  }

  /**
   * Revokes a tenant credential. The tenant keeps working but can no longer
   * authenticate, which is the safe direction for a revocation to fail in.
   *
   * Persisted, so a restart cannot resurrect a credential an operator revoked.
   */
  public static revokeCredential(tenantId: string): void {
    const profile = TENANT_REGISTRY.get(tenantId);
    if (!profile) throw new Error(`Cannot revoke a credential for unknown tenant '${tenantId}'`);
    this.persist({ ...profile, apiKeyHash: '', updatedAt: new Date().toISOString() });
  }

  /**
   * Replaces the whole registry, used to hydrate tenants from durable configuration.
   *
   * Deprecated in favour of `bootstrap()`, which is what production uses. Retained because
   * an operator restoring a registry from a backup needs to set every record at once.
   */
  public static hydrate(profiles: TenantProfile[]): void {
    TENANT_REGISTRY.clear();
    for (const profile of profiles) this.persist(decodeProfile(encodeProfile(profile), profile.id));
  }

  public static listTenants(): TenantProfile[] {
    return Array.from(TENANT_REGISTRY.values());
  }

  public static getTenant(id: string): TenantProfile | undefined {
    return TENANT_REGISTRY.get(id);
  }

  /**
   * Registers or replaces a tenant, durably.
   *
   * The record is validated on the way in as well as out, so a caller cannot install a
   * profile that would then be unreadable on the next boot.
   */
  public static registerTenant(profile: TenantProfile): void {
    this.persist(decodeProfile(encodeProfile(profile), profile.id));
  }

  /** Drops the cache without touching the ledger. Test-only. */
  public static resetCacheForTests(): void {
    TENANT_REGISTRY.clear();
  }

  /** Cache and store are both updated, or neither is. */
  private static persist(profile: TenantProfile): void {
    const record = encodeProfile(profile);
    DurableStore.upsert(COLLECTION, profile.id, record);
    TENANT_REGISTRY.set(profile.id, profile);
  }
}

export { DEMO_TENANTS };
export type { TenantQuota };
