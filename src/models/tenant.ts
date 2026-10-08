/**
 * Multi-Tenant Domain Models
 * Core types for tenant partitioning, quota governance, and niche taxonomy.
 */

export enum IndustryNiche {
  REAL_ESTATE = 'real_estate',
  HEALTHCARE = 'healthcare',
  LOGISTICS = 'logistics',
  CUSTOM_B2B = 'custom_b2b',
}

export enum TenantSubscriptionTier {
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  PROVISIONING = 'provisioning',
}

export interface TenantQuota {
  maxRequestsPerMinute: number;
  maxDailyAiTokens: number;
  burstCapacity: number;
  storageLimitMb: number;
}

export interface TenantRbacRule {
  role: 'admin' | 'operator' | 'auditor' | 'viewer';
  permissions: string[];
}

/**
 * A scoped, expiring credential issued under a tenant's root credential.
 *
 * Stored beside the root digest rather than signed into the key: the only secret
 * comparison in the authentication path stays the reviewed scrypt verification, and a
 * revocation takes effect on the next request with no token to wait out. `revokedAt`
 * rather than deletion, so an audit trail can still name a credential that was
 * withdrawn.
 */
export interface ScopedCredential {
  id: string;
  digest: string;
  scopes: string[];
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface TenantProfile {
  id: string; // Tenant ID (partition key: e.g. "tenant_re_8841")
  name: string;
  niche: IndustryNiche;
  tier: TenantSubscriptionTier;
  status: TenantStatus;
  apiKeyHash: string;
  /**
   * Scoped credentials issued under this tenant's root credential. Absent on records
   * written before they existed; decoded as an empty list, never as "all access".
   */
  scopedCredentials?: ScopedCredential[];
  quota: TenantQuota;
  customGuardrails: string[];
  encryptionKeyId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantContext {
  tenantId: string;
  niche: IndustryNiche;
  tier: TenantSubscriptionTier;
  correlationId: string;
  authenticatedRole: string;
  quota: TenantQuota;
}
