# Software Factory Engineering Constitution

## Fundamental Principles & Invariants

### Article I: Tenant Partitioning & Zero Conflation
1. Every piece of business telemetry, database record, transformation ledger, and log MUST be partitioned by `tenant_id`.
2. Under no circumstance may context, credentials, encryption keys, or memory state be shared or conflated across tenant boundaries.
3. If an incoming payload specifies a tenant ID whose provisioned niche differs from the requested adapter, the runtime MUST immediately abort with `MALFORMED_CONTEXT`.

### Article II: Deterministic AI Transformation
1. All AI operations via Google Gemini MUST utilize strict structured output configurations (`responseSchema`).
2. Temperature MUST be capped at <= 0.1 for operational transformations to eliminate hallucination and schema drifting.
3. Every transformation must evaluate regulatory guardrails (e.g. Fair Housing non-discrimination, HIPAA PHI elimination, DOT cold-chain compliance) before returning success.

### Article III: Concurrency, Robustness, & Fail-Safe Design
1. The system must never fail silently. When payload validation or business rules fail, standardized error JSON must be returned: `{"status": "error", "code": "...", "message": "..."}`.
2. Downstream calls to AI APIs and Database layers must be guarded by Circuit Breakers with exponential backoff and jitter.
3. Microservices must be horizontally scalable, stateless, and containerized for automated Kubernetes orchestration.
