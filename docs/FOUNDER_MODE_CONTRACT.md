# Founder Mode Contract

Founder mode is the first real-world operating target for Software Factory. It optimizes for one trusted operator moving from an idea to a shipped, measurable software outcome without pretending that multi-customer SaaS concerns are already solved.

## Runtime boundary

The TypeScript modular monolith is the system of record for the founder workflow. The Rust service remains an optional high-throughput adapter until it shares the same contract tests and durable persistence adapter.

## Durability boundary

Local founder deployments persist telemetry, transformations, audit entries, and factory jobs in `.data/software-factory.json` using atomic replacement and restrictive file permissions. The persistence port is isolated behind `AppwriteService`, so Appwrite can replace the local adapter later.

## Security boundary

Production requests require `Authorization: Bearer $FACTORY_API_KEY` or `X-API-Key: $FACTORY_API_KEY`. Development requests may use loopback-only access when `ALLOW_INSECURE_LOCAL=true`. Tenant context is resolved server-side and all history, audit, and job reads are tenant-filtered.

## Factory boundary

The first factory workflow is a durable job state machine: capture an idea, produce a structured delivery brief, track implementation status, record validation evidence, and close the loop with outcome notes. Code generation and deployment adapters are explicit ports rather than hidden claims.

## Release invariant

Every claimed capability must be either backed by a real request path and test or labeled as simulated, planned, or unavailable.
