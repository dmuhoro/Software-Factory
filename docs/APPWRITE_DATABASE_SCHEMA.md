# Multi-Tenant Appwrite Database Architecture & Partitioning Specification

## 1. Executive Summary
The Software Factory operates a single consolidated Appwrite Database (`b2b_software_factory`) supporting diverse enterprise verticals (Real Estate, Healthcare, Logistics, Custom B2B). Strict multi-tenancy is guaranteed through **Tenant ID Partitioning** across all collections and **Document Security** enforced by Appwrite's native Attribute Permission engine.

---

## 2. Core Entity Architecture
Every entity collection maintains a mandatory `tenant_id` string attribute, preventing any cross-tenant visibility or unauthorized mutations:

| Collection ID | Purpose | Partition Key | Primary Security Boundary |
| :--- | :--- | :--- | :--- |
| `tenants` | Global tenant registry & subscription SLAs | `tenant_id` | `read("team:{tenant_id}/member")`, `update("team:{tenant_id}/admin")` |
| `tenant_settings` | Feature flags, guardrails, webhook configuration | `tenant_id` | `read("team:{tenant_id}/member")`, `update("team:{tenant_id}/admin")` |
| `tenant_users` | Tenant membership & RBAC role assignments | `tenant_id` | `read("team:{tenant_id}/admin")`, `update("team:{tenant_id}/admin")` |
| `telemetry_events` | Ingested raw telemetry payload events | `tenant_id` | `create("team:{tenant_id}/operator")`, `read("team:{tenant_id}/member")` |
| `ai_transformations` | Gemini structured transformations | `tenant_id` | `read("team:{tenant_id}/member")`, `update("team:{tenant_id}/admin")` |
| `audit_logs` | Tamper-evident cryptographic compliance trail | `tenant_id` | `read("team:{tenant_id}/auditor")` |

---

## 3. Role-Based Access Control (RBAC) Permission Matrix
Appwrite Teams are dynamically provisioned per tenant with standardized roles:

| Role | Permissions on Partitioned Data | Operational Intent |
| :--- | :--- | :--- |
| **Owner / Admin** | `read`, `create`, `update`, `delete` on settings, users, and transformations | Client organization administrators |
| **Operator** | `create` on `telemetry_events`, `read` on processing states | Automated IoT devices, MLS connectors, EHR integrations |
| **Member** | `read` on `telemetry_events` and `ai_transformations` | Standard dashboard users and business analysts |
| **Auditor** | `read` exclusively on `audit_logs` | External compliance auditors (SOC2 Type II, HIPAA, ISO 27001) |

---

## 4. Anti-Replay & Performance Indexing
- **Composite Unique Index `[tenant_id, idempotency_key]`**: Enforces that telemetry payloads cannot be re-executed within a tenant partition, preventing double billing and duplicate event actions.
- **Composite Key Index `[tenant_id, status]`**: Enables high-velocity polling of pending ingestion queues with zero scan leakage across tenants.
- **Composite Index `[tenant_id, compliance_verified]`**: Facilitates instant compliance reporting for regulatory inquiries.
