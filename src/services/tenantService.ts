/**
 * Tenant Governance and Isolation Service
 * Enforces zero-conflation memory boundaries and validates partition ownership.
 */

import { IndustryNiche, TenantProfile, TenantSubscriptionTier, TenantStatus, TenantContext } from '../models/tenant';
import { SUBSCRIPTION_QUOTAS } from '../configurations/factory.config';
import { emitMalformedContextError, emitSecurityError } from '../utils/validation';

// In-memory tenant registry (synced with Appwrite 'tenants' collection)
const TENANT_REGISTRY = new Map<string, TenantProfile>([
  [
    'tenant_re_8841',
    {
      id: 'tenant_re_8841',
      name: 'Apex Residential Realty',
      niche: IndustryNiche.REAL_ESTATE,
      tier: TenantSubscriptionTier.ENTERPRISE,
      status: TenantStatus.ACTIVE,
      apiKeyHash: 'hash_re_sec_49182a938',
      quota: SUBSCRIPTION_QUOTAS[TenantSubscriptionTier.ENTERPRISE],
      customGuardrails: ['RESPA_COMPLIANCE', 'FAIR_HOUSING_STRICT'],
      encryptionKeyId: 'arn:aws:kms:us-east-1:1122334455:key/re-tenant-key',
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  [
    'tenant_hc_1042',
    {
      id: 'tenant_hc_1042',
      name: 'Vanguard Health Systems',
      niche: IndustryNiche.HEALTHCARE,
      tier: TenantSubscriptionTier.ENTERPRISE,
      status: TenantStatus.ACTIVE,
      apiKeyHash: 'hash_hc_sec_77192bc01',
      quota: SUBSCRIPTION_QUOTAS[TenantSubscriptionTier.ENTERPRISE],
      customGuardrails: ['HIPAA_SAFE_HARBOR_18', 'HL7_FHIR_V4_STRICT'],
      encryptionKeyId: 'arn:aws:kms:us-east-1:1122334455:key/hc-tenant-key',
      createdAt: '2026-02-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
  ],
  [
    'tenant_log_5529',
    {
      id: 'tenant_log_5529',
      name: 'TransContinental Freight & ColdChain',
      niche: IndustryNiche.LOGISTICS,
      tier: TenantSubscriptionTier.PROFESSIONAL,
      status: TenantStatus.ACTIVE,
      apiKeyHash: 'hash_log_sec_99182df33',
      quota: SUBSCRIPTION_QUOTAS[TenantSubscriptionTier.PROFESSIONAL],
      customGuardrails: ['IATA_DANGEROUS_GOODS', 'REEFER_TEMP_MONITOR'],
      encryptionKeyId: 'arn:aws:kms:us-east-1:1122334455:key/log-tenant-key',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
  ],
]);

export class TenantService {
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

  public static listTenants(): TenantProfile[] {
    return Array.from(TENANT_REGISTRY.values());
  }

  public static getTenant(id: string): TenantProfile | undefined {
    return TENANT_REGISTRY.get(id);
  }

  public static registerTenant(profile: TenantProfile): void {
    TENANT_REGISTRY.set(profile.id, profile);
  }
}
