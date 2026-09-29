# Changelog - Software Factory Multi-Tenant B2B SaaS Platform

All notable architectural and code modifications are documented here.

## [4.8.0-asserted-controls] - 2026-09-29

The hardening that decides whether a control is real. Every item below shipped through at least
one release, or was a gate that reported success without proving anything.

### Security
- **The Kubernetes egress policy permitted 443 to `0.0.0.0/0`,** and the manifest gate passed it
  on all 57 checks. The gate asserted that a policy of type `Egress` existed. It never read what
  the egress rules permitted, so a policy covering egress and allowing the entire internet
  satisfied it. The comment in the file said "replace with a CIDR allowlist before production";
  the comment was the only control, and it was free. The base policy now denies all egress except
  DNS, and a deploy-time renderer resolves the two real hostnames to `/32` addresses. The
  rendered policy is a DNS snapshot, not a durable hostname filter -- NetworkPolicy cannot filter
  SNI, so the durable answer is an egress proxy or service mesh, and that remains open.
- **The image gate claimed to walk the layer history for credentials and never did.** Every
  no-credential check read the final container environment. `RUN echo "GEMINI_API_KEY=..." >
  /tmp/leak` followed by `RUN rm /tmp/leak` leaves a credential in an intermediate layer while
  the final environment looks clean. Both images are now inspected layer by layer, and the
  live-value scan reports that it was skipped when no credential is set rather than passing
  silently.
- **The deployment would have run a three-year-old binary.** `deployment.yaml` pinned
  `runtime:v3.2.0` -- immutable, so the existing gate passed -- while the software was 4.7.0. The
  gate now requires the deployed tag to equal the current version, and CI derives that tag from
  `package.json` instead of a literal that could disagree.
- **`ci.yml` could not publish a release image at all:** `push: false` with a hardcoded
  `:latest`. The tag is now derived from the version and pushing is gated on a credential this
  repository does not carry, so the build verifies and publishes nothing until one is added.

### Fixed
- **The production image had never been built.** CI typechecked, unit-tested and HTTP-harnessed
  the code and never built the thing that ships. The Rust runtime -- the image the deployment
  actually runs -- did not build at all: `rust:1.78-alpine` ships Cargo 1.78, and the committed
  `Cargo.lock` pins `rand_pcg 0.10.2`, which requires `edition2024`, unstabilized until 1.85.
  It also copied no `Cargo.lock`, passed no `--locked`, swallowed a failed build with `|| true`,
  and hardcoded `x86_64-unknown-linux-musl`, so it could not build on arm64.
- **The image shipped a bundler.** Ten build-time packages were declared as production
  dependencies, so `npm ci --omit=dev` installed vite and esbuild's native binaries into the
  runtime image. Classification is now asserted against the built bundle: a package is a runtime
  dependency only if `dist/server.cjs` requires it. Node image 119MB -> 86.6MB, Rust 36.9MB.
- **The artifact was built from something other than the thing that was tested, in both
  ecosystems.** `package-lock.json` and `bun.lock` described one manifest and resolved 63 of
  313 shared packages differently, while CI ran `npm ci` and both Docker stages ran
  `bun install --frozen-lockfile`. `bun.lock` is deleted; npm is canonical (ADR-007).
- **The founder playbook could not start the product.** It instructed
  `bun install --frozen-lockfile` after `bun.lock` was deleted, which fails outright. Migrated
  to `npm ci`, and `scripts/verify-docs.sh` now extracts every command a live document tells a
  reader to run and fails if it does not resolve.
- **Governance records were not reconciled in the commit that changed the behaviour they
  described.** NC-1/6/7 were resolved and left in the open table; NC-3/4/5 were resolved and
  left in the open table. Six of nine resolutions across two waves. Every row must now be
  classified as resolved or open and name the commit or wave that resolved it.
- **An integration could report a pass it never earned.** A job whose steps are all
  `continue-on-error` is green without verifying anything. `scripts/verify-integrations.sh`
  rejects that shape across all four integrations.

### Added
- **`scripts/kb-mcp-server.mjs` serves the repository to AI reviewers over MCP.** CodeRabbit is
  an MCP *client* -- its documentation states it "ingests data from your connected MCP servers,
  not the other way around" -- so the repository serves its own context rather than calling out.
  33 documents, read-only, every response carrying a `SOURCE:` line, refusing `.env` and the
  tenant ledger, with containment re-checked after path normalisation. Six attack paths are
  self-tested in CI. ADR-006.
- **`scripts/generate-dashboard.mjs` generates delivery status from Git.** No figure is typed by
  hand. It asserts its own coverage -- any `verify*` script it does not run is reported by name,
  which immediately surfaced four omitted harnesses -- and lists what it cannot measure, with
  owners, instead of printing a plausible number.
- **Three ADRs:** ADR-006 (repository as knowledge base over MCP), ADR-007 (one package manager;
  the lockfile is the build), ADR-008 (security controls are asserted, not documented).
- **Secret-gated integrations:** CodeRabbit, SonarQube, Snyk, Datadog. Each is conditioned on
  its own credential so a fork PR is not failed for a secret the contributor cannot have.
- **Negative controls across every gate added in this release.** Three of the four ADR-007
  controls passed on first run, and two controls in this release passed because the mutation
  never applied. Both are recorded: a green negative control is as dangerous as a test that
  never ran.

### Known open
- **NC-2: TypeScript persistence is single-writer and single-replica.** By design, not by
  oversight. Horizontal scaling requires a shared transactional store.
- **The egress allowlist is a DNS snapshot.** Durable hostname filtering needs an egress proxy or
  service mesh; a NetworkPolicy cannot filter SNI.
- **Nothing is connected.** Every integration, the registry push, and live Gemini/Appwrite
  verification require credentials absent from this environment. The dashboard reports each as
  unmeasured with its owner rather than implying coverage.
- **The v4.8.0 image is not in GCR.** The manifest now refuses to drift, but publishing remains
  credential-blocked.

## [4.7.0-production-hardening] - 2026-09-29

Layers 2 through 4 of the production hardening programme. Every item below was a defect
that reached `main`; each is named with what it actually did, not with the class of bug
it belonged to.

### Security
- **The Rust tenant guard was never applied to the router.** `require_tenant_header` existed,
  was documented, and did not run. `main.rs` layered only `TraceLayer`, so
  `POST /api/v1/telemetry/ingest` accepted writes for any tenant from any unauthenticated
  caller. It is now layered onto the real router and authenticates rather than checking that
  a header exists: the presented key must be the one provisioned for the claimed tenant,
  compared in constant time. A tenant with no provisioned credential is unwritable, and one
  credential bound to two tenants is a startup error.
- **`GET /api/v1/tenants` returned the full tenant list to anyone.** Replaced by
  `GET /api/v1/tenants/me`, which returns the caller its own profile using the tenant id the
  guard resolved, so the partition is not caller-chosen.
- **`GEMINI_API_KEY` defaulted to `TEST_KEY`,** and the client returned a canned response for
  that placeholder. A misconfigured deployment answered with invented data that even
  asserted `complianceVerified: true`. All three Rust defaults (`GEMINI_API_KEY`,
  `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`) are now refused at startup, verified to exit 1.
- **The tenant audit report was unescaped.** `eventType`, `correlationId` and `timestamp`
  originate in telemetry the client posted, and the report is written to a file an auditor
  opens, so the document was attacker-authored. All eleven interpolation sites now escape.
- **The Gemini key travelled in the URL query string,** where intermediary access logs keep a
  durable copy. It is sent in a header.
- **Per-tenant credential binding (TypeScript).** Salted-scrypt digests, and one credential
  resolves to exactly one partition.

### Fixed
- **The writer lock did not exist.** `persist()` released it in a `finally` and the store only
  took it on first load, so it was held for the length of a single load. A second process
  opened the same ledger without complaint and, because the adapter rewrites the whole file
  per change, would have silently overwritten the first one's records. The lock is now held
  for the life of the process and released explicitly on shutdown. It is also created after
  the data directory is ensured to exist, which a first run on an empty volume needs.
- **Startup failed open.** An unhealthy pre-flight only printed its result and bound a port
  anyway. A contended or unusable ledger now refuses to serve and exits 75.
- **Every API failure was reported as `409` with `error.message` published verbatim,** so a
  corrupt ledger, a filesystem error and a `TypeError` all invited the caller to retry a
  server-side failure, and absolute paths and internal identifiers reached the client. Status,
  code and message are now decided in one classifier; unknown faults answer `500` with a
  correlation id.
- **An unknown `/api` path returned 200 with an HTML body,** so a mistyped endpoint looked
  like a successful call. It is now a 404 with JSON.
- **`persist_transformation` wrote nothing and returned `Ok(())`,** logging "persistence
  completed". The pipeline spawned it and discarded the result, so callers received success
  and an audit trail asserting an immutable record that was never written. It performs the
  write, returns failures, and the pipeline awaits it and refuses the event when the audit
  record cannot be stored.
- **`/health` reported `"circuit_breaker": "CLOSED"` and `"hpa_status": "READY"` as string
  literals.** Both are gone. Liveness reports only that the process runs; `/ready` reports 503
  with the missing variables when configuration is absent.
- **The readiness probe pointed at `/health`,** which answers 200 whenever the process is
  alive, so a pod missing its credentials would still have been handed traffic it refuses.
- **The ingress carried a cert-manager issuer annotation with no `tls` block,** so nothing
  bound the certificate and the host would have been served over plain HTTP.
- **Retried AI work had no wall-clock deadline.** A 25s per-attempt timeout with three
  retries held a request for over 90 seconds. A retry budget without a time budget does not
  bound latency; the total is now a required finite `deadlineMs`, and expiry surfaces as
  `OPERATION_DEADLINE_EXCEEDED` with the provider error attached as `cause`.
- **Building a report threw on a log with no `status`,** rather than degrading.
- **The client key was an unbounded `unwrap()`** on the TLS client build, panicking a worker
  thread on a TLS setup failure.
- **Both verification harnesses recorded the subshell pid instead of `node`'s,** leaking a
  listening server that squatted the port and failed the next run with `EADDRINUSE`.
- **The Layer 2 throttle probe asserted against a design that no longer existed** and ran on
  an ENTERPRISE tenant where zero refusals is correct, so it could never have passed.

### Added
- Per-tenant credential provisioning, verification and revocation; credential-bound tenant
  authentication; authenticated-principal rate limiting.
- `GET /api/v1/tenants/me`; `GET /ready`; `TENANT_API_KEYS`; `APPWRITE_API_KEY`.
- `src/utils/apiError.ts`, `src/utils/respondWithError.ts`, `src/utils/tenantCredentials.ts`.
- `scripts/verify-layer2.sh`, `scripts/verify-layer3.sh`, `software_factory/scripts/verify-k8s.py`.
- `software_factory/tests/tenant_guard_tests.rs`.
- k8s `NetworkPolicy`, `namespace.yaml`, `secret.example.yaml`.
- `.github/workflows/verify.yml`, gating typecheck, tests, the three live harnesses,
  `cargo fmt`, `cargo clippy -D warnings`, `cargo test`, and 51 manifest assertions.

### Verification
- TypeScript: 76/76 tests, `tsc --noEmit` clean, production build clean.
- Live harnesses against the built server: Layer 1 34/34, Layer 2 26/26, Layer 3 24/24, with
  no server left listening afterwards.
- Rust: 15/15 tests (`cargo test`), `cargo clippy --all-targets -- -D warnings` clean,
  `cargo fmt --check` clean.
- The compiled Rust binary was driven over HTTP: unauthenticated write refused 401,
  credential-for-another-tenant refused 403, invented tenant refused 403, `/health` public
  200, anonymous tenant read 401, own-tenant read 200. All three missing-variable startup
  cases exit 1.
- Manifests: 51/51 assertions. Verified that reverting the readiness path fails the check.
- Test discrimination was confirmed by reverting each fix: the report-escaping tests fail on
  a pass-through `escapeHtml`, the deadline tests fail with the budget removed, and the
  manifest validator fails on a `/health` readiness probe.

### Open, deliberately not closed
- **The TypeScript tenant registry is in-memory.** Provisioned tenants do not survive a
  restart, and this service cannot be scaled horizontally without a shared registry. Stated
  here rather than implied away.
- **Both `bun.lock` and `package-lock.json` are now tracked.** CI runs under npm because that
  is what the harnesses were executed with. Pick one package manager, drop the other lockfile,
  re-run the harnesses.
- **The Docker image has never been built.** The image runs as non-root and carries no
  secrets, but that is verified by inspection, not by a build.
- **The Layer 2 configuration edge cases** are unchanged: a credential configured for an
  unknown tenant id is a warning rather than a startup failure, and plaintext
  `FACTORY_TENANT_CREDENTIALS` is retained in process memory for the life of the process.
- **The k8s NetworkPolicy egress rule allows 443 to `0.0.0.0/0`.** Replace with a CIDR
  allowlist or an egress gateway before production.

## [4.6.0-machine-building] - 2026-09-24
### Added
- **Durable Agent Runner**: Added queue jobs, worker leases, retry limits, lease-expiry recovery, cancellation, and completion evidence.
- **Model Execution Bridge**: Added bounded provider-to-task proposal execution that records model output without falsely claiming repository mutation.
- **Sandbox Policy Contract**: Added explicit runtime, network, secret, source-boundary, resource, timeout, and image controls.
- **Deployment Observation**: Added health observation windows, consecutive-failure thresholds, durable runtime-health failures, and rollback recommendations.
- **Merge Recovery**: Added ordered worktree merging, conflict capture, merge abort behavior, and merge evidence.
- **Quality Gates**: Added project-family adapter detection, credential-like secret scanning, and package-audit integration.
- **Operations API**: Added authenticated endpoints for queue, sandbox, observation, merge, adapter, and security operations.
- **Sprint 14 Documentation**: Added the machine-building contract and pre-verification implementation record.

### Verification
- The automated suite passes 26 tests and TypeScript lint. Production build and final local reality verification remain the last phase before readiness determination.

## [4.5.0-levels-2-4] - 2026-09-23
### Added
- **Client Delivery**: Added isolated client workspaces, reproducible handover packs, checksums, acceptance criteria, and explicit client acceptance evidence.
- **Hosted Deployment Contract**: Added provider-neutral hosted targets, secret references, immutable artifact checksums, health observation, approval gating, and rollback records.
- **Frontier Model Boundary**: Added provider-neutral OpenAI-compatible model registration, runtime discovery, and secret-reference configuration.
- **Parallel Agent Governance**: Added dependency-aware task plans, isolated Git worktrees, ready-task scheduling, bounded parallelism, and deterministic merge plans.
- **Readiness Proof Ledger**: Added observed proof records, artifact references, measurements, evidence digests, and declaration-readiness summaries for Levels 1–4.
- **Sprint 13 Documentation**: Added the Levels 2–4 implementation contract and operational evidence requirements.

### Verification
- The complete suite passes 23 tests, TypeScript lint, and the production build path. Real-world readiness remains evidence-gated until the documented founder, client, hosted deployment, failure-injection, and hardened-execution runs are completed.

## [4.4.0-real-world-readiness] - 2026-09-21
### Added
- **Founder Workspace**: Added canonical project registration, lifecycle metadata, daily inbox, and checksum-validated ledger backup/restore.
- **Complete Lifecycle**: Added definition-of-done tasks, continuation reports for incomplete repositories, expanded lifecycle statuses, and evidence-aware delivery gates.
- **Execution Boundary**: Added ephemeral commit snapshots, sanitized environment metadata, disabled-network policy, bounded execution limits, run digests, and cleanup.
- **Release Adapter**: Added immutable filesystem releases, artifact checksums, health checks, approval-gated deployment, current-release pointers, and rollback to a previous known-good artifact.
- **Recovery and Anti-Fragility**: Added failure taxonomy, prescribed next actions, retry budgets, escalation, resolution evidence, and release-health failure recording.
- **Product Outcomes**: Added durable adoption, retention, time-saved, revenue, client-acceptance, feedback, defect, incident, and learning signals.
- **Bounded Autonomy**: Added graduated autonomy sessions with allowlisted actions, step limits, retry limits, cost budgets, and irreversible-action escalation.
- **Sprint 12 Documentation**: Added the real-world readiness implementation record and updated the harness contract and founder operating playbook.
- **Verification**: The complete test suite passed 19 tests, lint, production build, whitespace checks, and protected API smoke tests at the time of release.

## [4.3.0-harness-engineering] - 2026-09-21
### Added
- **Verification Profiles**: Added repository-aware verification for Node/npm, Android Gradle, Rust Cargo, Python, and Git integrity projects with bounded sequential execution.
- **Bounded Repair Loop**: Added failure classification, explicit patch attempts, retry limits, and durable repair evidence.
- **Approval Policy**: Added tenant-scoped approval requests and a production-delivery gate for irreversible actions.
- **Context Refresh and Promotion**: Added approved-workspace repository refresh and explicit promotion of verified patterns into institutional DNA.
- **Harness APIs and Tests**: Added repair-loop, approval, context-refresh, and pattern-promotion endpoints; expanded the verification suite to 11 passing tests.
- **Sprint 11 Documentation**: Added the product-manufacturing harness contract and implementation record.

## [4.2.0-context-compounding] - 2026-09-20
### Added
- **Repository Context Index**: Imported distilled product, architecture, security, quality, operations, and knowledge context from Forge.ai, Hermes-Forge, Forge, Portable-UI-Engine, and ShrinkMedia.
- **Context-Aware Planning**: Implementation plans now inherit relevant repository patterns and trust-layer quality gates through deterministic context search.
- **Compounding Quality Score**: Added evidence-derived launch quality snapshots across verification, security, evidence, operability, and product discipline, including baseline and percentage improvement tracking.
- **Sprint 10 Documentation**: Added the repository context index and the context-compounding implementation record.

## [4.1.0-controlled-delivery] - 2026-09-18
### Added
- **Product Foundry Context**: Added the adopted founder/company operating model, trust-layer principles, bounded autonomy rule, and institutional-memory direction.
- **Controlled Repository-to-Delivery Loop**: Added durable product briefs, implementation plans, approved workspace branch preparation, explicit file modification, bounded repository verification, verified build previews, and evidence attachment.
- **Sprint 09 Documentation**: Added the delivery-loop implementation record and release boundaries.

## [4.0.0-founder-mode] - 2026-09-18
### Added
- **Durable Founder Runtime**: Added atomic local persistence for telemetry, transformations, audit entries, and founder workflow jobs through the `AppwriteService` persistence port.
- **Tenant-Safe API Boundary**: Added fail-closed bearer/API-key authentication, loopback-only development access, tenant context verification, and request body limits.
- **Founder Software Factory Loop**: Added durable idea-to-delivery jobs with explicit state transitions and evidence recording at `/api/factory-jobs`.
- **Measured Operations**: Replaced fabricated health and throughput values with process, persistence, latency, and audit metrics.
- **Verification and Delivery**: Added founder-mode tests, a frozen Bun CI pipeline, a non-root production container, a founder contract, an operating playbook, and Sprint 08 documentation.

## [3.5.0] - 2026-09-16
### Added
- **Tenant Audit PDF-Style Report**: Implemented `/src/utils/reportGenerator.ts` providing executive-level structured compliance, security flag summaries, and performance metric reports with automated print-to-PDF generation.
- **Tail-Latency Heatmap Distribution**: Implemented `/src/components/LatencyHeatmap.tsx` and integrated it into the 'Rust Tokio Engine' tab via `/src/components/RustMetricsCharts.tsx` for real-time visualization of 15-minute rolling p99 and latency tiers.
- **Interactive Circuit Breaker Management**: Enhanced the Health Dashboard with dedicated indicators and interactive controls allowing manual resetting of tripped circuits (`geminiEngine`, `appwriteLedger`, `downstreamGateways`) and simulation trip-testing.
- **Compare Payloads & Configuration Drift Detection**: Created `/src/components/ComparePayloadsModal.tsx` and integrated a one-click comparison tool in the Ingestion Console toolbar to analyze added, removed, and modified payload parameters against the last successful request, with a one-click rollback feature.
- **Sprint 07 Documentation**: Created `/sprints/sprint-07-analytics-resilience-drift.md` detailing all architectural additions.

## [3.4.0] - 2026-09-16
### Added
- **Detailed Rust Trace Toggle**: Added an interactive 'Detailed Trace' toggle to the Execution Result area that surfaces raw simulated Rust backtraces (`RUST_BACKTRACE=full`), worker thread ID, panic origin, and CPU registers for failed ingestion events.
- **Configurable Polling Frequencies**: Implemented user-configurable auto-refresh interval setting (`manual`, `5s`, `30s`) in `App.tsx` and the Health Dashboard for fine-tuned client performance and reduced network footprint.
- **Health Dashboard Component**: Created `/src/components/HealthDashboard.tsx` featuring real-time threadpool saturation meters, 32-worker Tokio work-stealing grid, memory pressure visual gauges, and tri-service circuit breaker indicators (`geminiEngine`, `appwriteLedger`, `downstreamGateways`).
- **Rust Stack Trace Diagnostics**: Implemented `generateRustStackTrace` in `/src/utils/validation.ts` and integrated `rustTrace` into error response envelopes in `/src/api/routes/telemetry.routes.ts`.
- **Sprint 06 Documentation**: Authored `/sprints/sprint-06-observability-diagnostics.md` detailing the diagnostics architecture and performance optimizations.

## [3.3.0] - 2026-09-16
### Added
- **Rockefeller Hexagonal Architecture Framework**: Established ADR-004 defining the "Command the Interfaces, Despise the Commodities" doctrine, prioritizing pure domain rules decoupled from swappable cloud infrastructure.
- **NotebookLM AI Labor Knowledge Layer**: Authored `/docs/NOTEBOOKLM_KNOWLEDGE_LAYER.md` specifying the 4-tier grounding corpus (Blueprints, Video Transcripts, Interface Contracts, Compliance Guardrails) to eliminate structural drift in AI code generation.
- **Sprint 05 Documentation**: Created `/sprints/sprint-05-sdlc-automation-knowledge-layer.md` outlining the end-to-end automated SDLC assembly line.
- **Executive Master Prompts & System Protocols**: Standardized production-grade prompt suites for continuous multi-niche product development linked to Appwrite and GitHub.

## [3.2.0] - 2026-09-16
### Added
- **Appwrite Multi-Tenant Database Architecture**: Defined 4 core partitioned collections (`tenants`, `telemetry_events`, `ai_transformations`, `audit_logs`) with attribute-level team permissions and composite unique indexes.
- **Appwrite Node.js Serverless Function**: Created `/appwrite-functions/gemini-orchestrator/index.js` using `@google/genai` and `node-appwrite` with exponential backoff and circuit breaker.
- **Strict Structured JSON Schema Protocol**: Implemented `responseSchema` definitions for Real Estate, Healthcare, and Logistics using `@google/genai` `Type` enum.
- **High-Performance Rust Tokio Software Factory**: Scaffolded complete repository in `/software_factory` featuring Axum, Tokio multi-threaded concurrency, `NicheAdapter` traits, integration tests, Docker multi-stage build, and Kubernetes manifests (HPA, Deployment, Ingress).
- **Zero-Conflation Governance**: Implemented strict tenant validation and standardized error emission (`MALFORMED_CONTEXT`) preventing cross-niche leakage.
- **Interactive Mission Control Dashboard**: Full-stack web application connecting to Express `/api/*` routes with live telemetry stream runner, schema explorer, Rust engine viewer, and sprint tracker.
- **Engineering Documentation**: Authored Constitution (`/docs/CONSTITUTION.md`), ADRs 001-003, and Sprint plans 01-04.
