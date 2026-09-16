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

export interface TenantProfile {
  id: string; // Tenant ID (partition key: e.g. "tenant_re_8841")
  name: string;
  niche: IndustryNiche;
  tier: TenantSubscriptionTier;
  status: TenantStatus;
  apiKeyHash: string;
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
