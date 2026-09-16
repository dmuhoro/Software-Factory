# ADR-001: Multi-Tenant Appwrite Database Partitioning & Attribute Permissions

## Status
Accepted

## Context
The Software Factory serves distinct B2B industry verticals (Real Estate, Healthcare, Logistics) through a single core platform. We require strict tenant data isolation, zero-conflation query boundaries, and compliance certifications (HIPAA, SOC2).

## Decision
1. **Partition Key Strategy**: Every collection (`tenants`, `telemetry_events`, `ai_transformations`, `audit_logs`) includes a mandatory `tenant_id` string attribute.
2. **Appwrite Document Security**: Enable `documentSecurity: true` on all collections.
3. **Attribute-Based Permissions**:
   - Members: `Permission.read(Role.team(tenant_id, "member"))`
   - Operators: `Permission.create(Role.team(tenant_id, "operator"))`
   - Admins: `Permission.update(Role.team(tenant_id, "admin"))`
   - Auditors: `Permission.read(Role.team(tenant_id, "auditor"))`
4. **Composite Unique Indexing**: Composite unique index on `[tenant_id, idempotency_key]` to eliminate replay attacks within a tenant partition.

## Consequences
- Positive: Zero risk of cross-tenant data leakage; Appwrite native team permissions enforce isolation at the database engine level.
- Mitigations: Tenant context is checked in API gateway middleware before reaching database layers.
