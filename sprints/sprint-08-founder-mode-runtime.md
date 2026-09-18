# Sprint 08: Founder Mode Runtime and Evidence Loop

## Objective

Turn the Software Factory from a dashboard-heavy prototype into a dependable one-person-company operating system for moving from ideas to shipped, evidenced software outcomes.

## Completed

- Replaced process-local telemetry and transformation maps with an atomic durable local ledger.
- Added tenant-scoped idempotent telemetry persistence and immutable audit entries.
- Added fail-closed API authentication with bearer/API-key support and loopback-only development access.
- Added durable factory jobs with explicit IDEA → SPECIFIED → IMPLEMENTING → VALIDATING → DELIVERED transitions.
- Added evidence recording to factory jobs and tenant-isolated reads.
- Replaced fabricated operational metrics with measured process, persistence, latency, and audit metrics.
- Added request body limits and graceful HTTP shutdown.
- Added Bun CI for frozen dependency installation, lint, tests, build, and container build.
- Added a non-root production container.
- Added founder-mode contract and operating playbook.

## Verification evidence

- `bun run lint` passes.
- `bun test` passes three founder-mode tests covering persistence reload, idempotency, PHI rejection, tenant isolation, and state transitions.
- `bun run build` passes for the Vite frontend and Express server bundle.
- `git diff --check` passes.

## Explicit boundaries

The Rust runtime remains an optional high-throughput adapter until Rust tooling is installed in CI and its API contract tests exercise the same durable persistence and security boundaries. Appwrite remains a future infrastructure adapter behind the persistence port. Repository generation, isolated code execution, deployment, and outcome ingestion are the next factory adapters; the founder job contract is already durable and ready to host them.
