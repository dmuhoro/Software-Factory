/**
 * Appwrite Multi-Tenant Database Architecture & Schema Specification
 * 
 * Provides concrete definitions for:
 * 1. Database ID: "b2b_software_factory"
 * 2. Core Entities: tenants, tenant_settings, tenant_users, telemetry_events, ai_transformations, audit_logs, domain_records
 * 3. Tenant ID Partitioning across every collection
 * 4. Document-Level & Attribute Permissions based on user roles and tenantId
 * 5. Composite Indexes for zero-latency queries and replay-attack protection
 */

export interface AppwriteAttributeDef {
  key: string;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'datetime' | 'enum';
  size?: number;
  required: boolean;
  default?: unknown;
  array?: boolean;
  elements?: string[]; // for enums
  description: string;
}

export interface AppwriteIndexDef {
  key: string;
  type: 'key' | 'unique' | 'fulltext';
  attributes: string[];
  orders?: ('ASC' | 'DESC')[];
  description: string;
}

export interface AppwriteCollectionBlueprint {
  collectionId: string;
  name: string;
  documentSecurity: boolean;
  defaultPermissions: string[]; // e.g. ["read(\"team:{tenant_id}/member\")", "create(\"team:{tenant_id}/admin\")"]
  attributes: AppwriteAttributeDef[];
  indexes: AppwriteIndexDef[];
  isolationGuarantee: string;
}

export const APPWRITE_DATABASE_CONFIG = {
  databaseId: 'b2b_software_factory',
  name: 'B2B Multi-Niche Software Factory DB',
  description: 'Enterprise multi-tenant data layer partitioned by Tenant ID with strict attribute security',
};

export const TENANTS_COLLECTION_BLUEPRINT: AppwriteCollectionBlueprint = {
  collectionId: 'tenants',
  name: 'Tenants Registry',
  documentSecurity: true,
  defaultPermissions: [
    'read("team:{tenant_id}/member")',
    'update("team:{tenant_id}/admin")',
    'delete("team:{tenant_id}/owner")',
  ],
  attributes: [
    { key: 'tenant_id', type: 'string', size: 64, required: true, description: 'Unique Partition ID (e.g. tenant_re_8841)' },
    { key: 'name', type: 'string', size: 128, required: true, description: 'Organization legal trade name' },
    { key: 'niche', type: 'enum', elements: ['real_estate', 'healthcare', 'logistics', 'custom_b2b'], required: true, description: 'Industry vertical' },
    { key: 'tier', type: 'enum', elements: ['starter', 'professional', 'enterprise'], required: true, default: 'starter', description: 'SLA Subscription tier' },
    { key: 'status', type: 'enum', elements: ['active', 'suspended', 'provisioning'], required: true, default: 'active', description: 'Lifecycle state' },
    { key: 'api_key_hash', type: 'string', size: 256, required: true, description: 'Argon2id cryptographic hash of client API secret' },
    { key: 'max_rpm', type: 'integer', required: true, default: 60, description: 'Rate limit bucket max requests per minute' },
    { key: 'max_daily_tokens', type: 'integer', required: true, default: 500000, description: 'Daily AI token budget ceiling' },
    { key: 'encryption_key_arn', type: 'string', size: 256, required: true, description: 'Cloud KMS Key reference for envelope encryption' },
    { key: 'custom_guardrails', type: 'string', size: 4096, required: false, description: 'JSON serialized array of tenant compliance rules' },
  ],
  indexes: [
    { key: 'idx_tenant_id_unique', type: 'unique', attributes: ['tenant_id'], description: 'Guarantees global uniqueness of tenant partition' },
    { key: 'idx_tenant_niche_tier', type: 'key', attributes: ['niche', 'tier'], description: 'Fast indexing for fleet telemetry aggregation' },
  ],
  isolationGuarantee: 'Strict Tenant-Team isolation. Global cross-tenant scans are blocked by Appwrite attribute rules.',
};

export const TENANT_SETTINGS_COLLECTION_BLUEPRINT: AppwriteCollectionBlueprint = {
  collectionId: 'tenant_settings',
  name: 'Tenant Settings & Feature Flags',
  documentSecurity: true,
  defaultPermissions: [
    'read("team:{tenant_id}/member")',
    'update("team:{tenant_id}/admin")',
  ],
  attributes: [
    { key: 'tenant_id', type: 'string', size: 64, required: true, description: 'Partition Tenant ID' },
    { key: 'fair_housing_guardrails', type: 'boolean', required: true, default: true, description: 'Enforce Fair Housing Non-Discrimination Guardrail' },
    { key: 'hipaa_strict_redaction', type: 'boolean', required: true, default: true, description: 'Enforce HIPAA 18 Safe Harbor PHI Redaction' },
    { key: 'coldchain_temp_alerting', type: 'boolean', required: true, default: true, description: 'Enforce Temperature Excursion Alerting' },
    { key: 'auto_db_sync', type: 'boolean', required: true, default: true, description: 'Automatic asynchronous DB ledger synchronization' },
    { key: 'audit_ledger_mirroring', type: 'boolean', required: true, default: true, description: 'Mirror transformations to immutable audit trail' },
    { key: 'webhook_url', type: 'string', size: 512, required: false, description: 'Outbound webhook destination for processed events' },
    { key: 'updated_at', type: 'datetime', required: true, description: 'Timestamp of last settings mutation' },
  ],
  indexes: [
    { key: 'idx_settings_tenant', type: 'unique', attributes: ['tenant_id'], description: 'One-to-one settings document per tenant partition' },
  ],
  isolationGuarantee: 'Only admin role within verified tenantId can view or toggle operational feature flags.',
};

export const TENANT_USERS_COLLECTION_BLUEPRINT: AppwriteCollectionBlueprint = {
  collectionId: 'tenant_users',
  name: 'Tenant Users & RBAC Matrix',
  documentSecurity: true,
  defaultPermissions: [
    'read("team:{tenant_id}/admin")',
    'read("team:{tenant_id}/member")',
    'update("team:{tenant_id}/admin")',
    'create("team:{tenant_id}/admin")',
  ],
  attributes: [
    { key: 'tenant_id', type: 'string', size: 64, required: true, description: 'Partition Tenant ID' },
    { key: 'user_id', type: 'string', size: 64, required: true, description: 'Appwrite Account user ID' },
    { key: 'email', type: 'string', size: 128, required: true, description: 'User corporate email' },
    { key: 'role', type: 'enum', elements: ['admin', 'operator', 'member', 'auditor'], required: true, default: 'member', description: 'Tenant-scoped RBAC role' },
    { key: 'is_active', type: 'boolean', required: true, default: true, description: 'User account status' },
    { key: 'last_login', type: 'datetime', required: false, description: 'Latest authentication timestamp' },
  ],
  indexes: [
    { key: 'idx_user_tenant_composite', type: 'unique', attributes: ['tenant_id', 'user_id'], description: 'Guarantees user uniqueness within a single tenant boundary' },
    { key: 'idx_tenant_role', type: 'key', attributes: ['tenant_id', 'role'], description: 'Fast role-based access filtering' },
  ],
  isolationGuarantee: 'Users are strictly bound to their tenantId team. No user can view or alter users in other partitions.',
};

export const TELEMETRY_EVENTS_COLLECTION_BLUEPRINT: AppwriteCollectionBlueprint = {
  collectionId: 'telemetry_events',
  name: 'Telemetry Ingestion Stream',
  documentSecurity: true,
  defaultPermissions: [
    'create("team:{tenant_id}/operator")',
    'read("team:{tenant_id}/member")',
  ],
  attributes: [
    { key: 'tenant_id', type: 'string', size: 64, required: true, description: 'Partition Tenant ID' },
    { key: 'niche', type: 'string', size: 32, required: true, description: 'Industry vertical adapter' },
    { key: 'event_type', type: 'string', size: 64, required: true, description: 'Domain event name (e.g. PROPERTY_LISTED, PATIENT_INTAKE)' },
    { key: 'idempotency_key', type: 'string', size: 128, required: true, description: 'Client-supplied UUID to prevent duplicate ingestion' },
    { key: 'raw_payload', type: 'string', size: 65535, required: true, description: 'Serialized JSON telemetry content (encrypted at rest)' },
    { key: 'status', type: 'enum', elements: ['RECEIVED', 'VALIDATING', 'ROUTED_TO_ADAPTER', 'AI_PROCESSING', 'COMPLETED', 'FAILED', 'DLQ_ROUTED'], required: true, default: 'RECEIVED', description: 'Pipeline processing state' },
    { key: 'ip_hash', type: 'string', size: 64, required: false, description: 'Hashed sender IP for DDoS and anomaly detection' },
    { key: 'client_version', type: 'string', size: 32, required: false, description: 'Agent or SDK client version' },
  ],
  indexes: [
    { key: 'idx_tenant_idempotency', type: 'unique', attributes: ['tenant_id', 'idempotency_key'], description: 'Composite unique index eliminates replay attacks within tenant scope' },
    { key: 'idx_tenant_status_created', type: 'key', attributes: ['tenant_id', 'status'], description: 'High-throughput queue polling partitioned by tenant' },
  ],
  isolationGuarantee: 'Row-level security enforces that events cannot be read or written outside the verified tenant team token.',
};

export const AI_TRANSFORMATIONS_COLLECTION_BLUEPRINT: AppwriteCollectionBlueprint = {
  collectionId: 'ai_transformations',
  name: 'Gemini AI Transformations Ledger',
  documentSecurity: true,
  defaultPermissions: [
    'read("team:{tenant_id}/member")',
    'update("team:{tenant_id}/admin")',
  ],
  attributes: [
    { key: 'tenant_id', type: 'string', size: 64, required: true, description: 'Partition Tenant ID' },
    { key: 'telemetry_event_id', type: 'string', size: 64, required: true, description: 'Foreign pointer to raw telemetry document' },
    { key: 'niche', type: 'string', size: 32, required: true, description: 'Industry vertical adapter executed' },
    { key: 'model_id', type: 'string', size: 64, required: true, description: 'Exact Gemini model version used (e.g. gemini-1.5-pro / gemini-3.8-flash)' },
    { key: 'structured_output', type: 'string', size: 65535, required: true, description: 'Strict validated JSON compliant with Niche Response Schema' },
    { key: 'confidence_score', type: 'float', required: true, description: 'Confidence metric 0.00 to 1.00' },
    { key: 'compliance_verified', type: 'boolean', required: true, default: false, description: 'HIPAA / Fair Housing / DOT compliance audit status' },
    { key: 'tokens_consumed', type: 'integer', required: true, default: 0, description: 'Prompt and completion token tally for quota accounting' },
    { key: 'duration_ms', type: 'integer', required: true, default: 0, description: 'End-to-end transformation latency in milliseconds' },
    { key: 'retry_attempts', type: 'integer', required: true, default: 0, description: 'Retry counter before circuit breaker tripped' },
  ],
  indexes: [
    { key: 'idx_tenant_telemetry', type: 'key', attributes: ['tenant_id', 'telemetry_event_id'], description: 'One-to-one transformation resolution index' },
    { key: 'idx_tenant_compliance', type: 'key', attributes: ['tenant_id', 'compliance_verified'], description: 'Fast filtering for tenant compliance auditors' },
  ],
  isolationGuarantee: 'Encrypted at rest with tenant KMS key; accessible only via verified tenant team permissions.',
};

export const AUDIT_LOGS_COLLECTION_BLUEPRINT: AppwriteCollectionBlueprint = {
  collectionId: 'audit_logs',
  name: 'Immutable Compliance Audit Trail',
  documentSecurity: true,
  defaultPermissions: [
    'read("team:{tenant_id}/auditor")',
  ],
  attributes: [
    { key: 'tenant_id', type: 'string', size: 64, required: true, description: 'Partition Tenant ID' },
    { key: 'actor_id', type: 'string', size: 64, required: true, description: 'Service identity or user ID who performed the operation' },
    { key: 'action', type: 'string', size: 64, required: true, description: 'SYSTEM_TRANSFORM, SCHEMA_MUTATION, EXPORT, ACCESS' },
    { key: 'resource_uri', type: 'string', size: 256, required: true, description: 'Target document identifier' },
    { key: 'ip_address', type: 'string', size: 64, required: true, description: 'Caller network address' },
    { key: 'checksum', type: 'string', size: 128, required: true, description: 'SHA-256 cryptographic chain hash for tamper-evidence' },
  ],
  indexes: [
    { key: 'idx_tenant_audit_created', type: 'key', attributes: ['tenant_id'], description: 'Chronological query ledger for compliance certifications' },
  ],
  isolationGuarantee: 'Append-only ledger. Write permissions restricted to internal microservices; updates and deletes permanently rejected.',
};

export const ALL_COLLECTION_BLUEPRINTS = [
  TENANTS_COLLECTION_BLUEPRINT,
  TENANT_SETTINGS_COLLECTION_BLUEPRINT,
  TENANT_USERS_COLLECTION_BLUEPRINT,
  TELEMETRY_EVENTS_COLLECTION_BLUEPRINT,
  AI_TRANSFORMATIONS_COLLECTION_BLUEPRINT,
  AUDIT_LOGS_COLLECTION_BLUEPRINT,
];
