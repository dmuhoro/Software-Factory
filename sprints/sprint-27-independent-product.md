# Sprint 27 — The Independent Product

**Status:** in progress · **Opened:** 2026-10-10

**Thesis:** Software Factory must be a complete product that stands on its own —
it must absorb what Forge proved, be honest about what it actually runs, and be
hostable without a paid platform. This sprint is the layer-by-layer execution of
that, with a named proof command for every claim.

Follows `docs/CONSTITUTION.md`, the ADRs in `docs/adr/`, and the cross-repo SOP.

---

## Forge → Software Factory parity (evidence, not narrative)

Forge's durable value is described in `docs/REPOSITORY_CONTEXT_INDEX.md` as
*planner/reviewer separation, evaluation-driven change, sandbox execution,
SOP-driven operations*. Auditing the SF tree shows most of that is already
present, which is itself the finding: the gap is narrower than the framing.

| Forge capability | Where it lives in SF today | Status |
|---|---|---|
| Planner / implementer separation | `implementerService.ts` (model returns a file manifest, never prose) | present |
| Reviewer gate | `reviewService.ts` (judgement-tier verdict before any commit) | present |
| Evaluation-driven change | `qualityGateService.ts`, `verificationProfileService.ts`, `loopGates.ts` | present |
| Sandbox execution | `sandboxPolicyService.ts`, `executionBoundaryService.ts` | present |
| SOP-driven operations | `doctrineService.ts`, `doctrineIsolationService.ts` | present |
| Ecosystem context / RAG | `contextIndexService.ts` | present (deterministic retrieval) |
| Outcome telemetry | `outcomeService.ts`, `observationService.ts` | present |
| Parallel worktrees | `parallelWorktreeService.ts` | present |
| Append-only task journal | the loop's durable store + audit events | present (superset) |
| Ecosystem hub (multi-product landing) | not consolidated | **gap** |
| Disposable MV3 browser corridor | absent | **gap (deferred; not a product dependency)** |

Conclusion: SF does **not** depend on Forge at runtime. The genuine work is
closing the honesty and provisioning gaps below, not porting Forge's loop.

## Work packages

| WP | Objective | Proof |
|---|---|---|
| **WP-1** | Deploy provenance: a live URL states the build it serves | health + UI badge read the real `package.json` version |
| **WP-2** | Remove fabricated runtime telemetry the Node process never measures | no reachable metric is invented; dashboard renders real fields |
| WP-3 | Appwrite persistence real, idempotent, failure-tested | write survives restart; failure test fails closed |
| WP-4 | Durable auth/rate-limits + cross-tenant security tests | cross-tenant read/write refused |
| WP-5 | Model productionisation: startup validation, cost caps | unsupported model fails startup; cap refuses |
| WP-6 | Repository tooling / PR flow | loop opens a real PR |
| WP-7 | Isolated execution boundary (ADR + doctrine) | ADR accepted; escape test refused |
| WP-8 | Evaluation harness scoring generated products | harness scores a known-bad product low |
| WP-9 | CI/CD, backups, restore + load tests | restore returns the data; pipeline is the gate |
| WP-10 | Scale & economics: queue isolation, budgets, metering | metering matches usage |
| WP-11 | One real customer wedge | an outcome metric beats the incumbent |

WP-6 … WP-11 depend on operator inputs that are not code: a GitHub App/token, a
hosted model key with spend, Appwrite provisioning, and a chosen customer. They
are sequenced but cannot be *completed* without those inputs; the blocker is
named in each case rather than worked around.

---

## WP-1 — Deploy provenance (4.13.4)

**The defect the user actually hit:** "I can't tell if the live deploy is the
latest build." The deployed code *was* current (the live JS was byte-identical to
a fresh build of `main`); the app simply never said so. The badge read
`v3.2.0-PROD`, a literal, and `/api/factory/health` carried no version at all.

**Fix:**
- `src/configurations/buildInfo.ts` — reads `package.json` at runtime, verifies
  the package `name` before trusting the manifest, resolves against both the
  working directory and the entrypoint, and reports `unknown` rather than guessing.
- `src/api/routes/factory.routes.ts` — `/api/factory/health` now returns
  `name` and `version`.
- `src/App.tsx` — the header badge is fed by that field, not a literal.

**Evidence:**
- `test/health-version.test.ts` asserts the payload version equals the real
  `package.json` version (not a literal). **Failing-first:** with the field
  reverted to a constant, the test fails (1 fail); with the fix, it passes.
- Production bundle (`npm run build` + `node dist/server.cjs`) →
  `GET /api/factory/health` → `name=software-factory version=4.13.4`.

## WP-2 — Runtime honesty (4.13.4)

**The defect:** the dashboard read `systemHealth.threadpool.*`,
`systemHealth.circuitBreakers.*` and `kubernetes.hpaReplicas`, none of which the
Node server sends. The read at `systemHealth.threadpool.totalWorkerThreads`
threw, the surrounding `catch` swallowed it, and `setHealthData` was never
reached — so the health board rendered nothing on the live deployment. Around it
sat fabricated telemetry: "Tokio Workers: 32 Active", jemalloc heap `?? 38 MB`,
trip/reset-able circuit breakers, and `hpaReplicas ?? 5` — claims about a Rust
runtime this service does not run.

**Fix:** the dashboard consumes only what `classifyReadiness()` and
`process.memoryUsage()` actually produce — status, readiness checks, heap/RSS/pressure,
uptime and the deployed version. Removed the fabricated threadpool, jemalloc heap,
trippable circuit breakers and HPA pod counts, deleted the dead fabricated components
(`TelemetryHealthBar`, `RustMetricsCharts`, `LatencyHeatmap`) and the "Rust Tokio Engine"
tab, and replaced the header chips with the real readiness status.

**Evidence:**
- `test/health-truthfulness.test.ts` — two arms: the API payload contains only measurable
  fields and none of the invented ones, and the health UI source contains no
  fabricated-runtime tokens. **Failing-first:** injecting `threadpool` into the dashboard
  fails arm 2; the payload assertions fail without `checkDetails`. With the fix: 2 pass.
- Full suite: **299/299**.

## WP-2b — Error-trace honesty (done)

The stream tab rendered a *simulated* Rust error trace: `generateRustStackTrace`
(`src/utils/validation.ts`) invented `tokio-runtime-worker` frames, `rustc` panic paths and
register dumps with `Math.random()`, and the trace view hard-coded `RUST_BACKTRACE=full`,
`RAX/RBX/RIP/RSP` registers and `[tokio-worker-12]` log lines. Same defect class as WP-2 — a
claim about a runtime the service does not run — in the error path, where fabricated
evidence is most dangerous.

**Finding that scoped the fix:** the product really does ship a Rust crate (`software_factory/`,
Axum + Tokio), but the Dockerfile does not build it and the running service is the Node control
plane (`dist/server.cjs`). ADR-003 and the "Sprint 04: Rust Tokio [DONE]" label are therefore
**true governance records of a real crate** and are kept; only the client-side *simulation* was
false.

**Fix:** deleted `generateRustStackTrace`/`RustStackTraceInfo`/`RustStackFrame` and the
`rustTrace` field; the error view shows the real envelope (code, correlation id, tenant,
server message) and states that no stack trace is synthesized; the success trace prints the
real correlation id, tenant, record id, guardrails and latency.

**Evidence:**
- `test/error-trace-truthfulness.test.ts` — the emitter carries no trace field and validation.ts
  holds no generator; the UI holds no source-level diagnostic tokens. **Failing-first:** injecting
  `rust_begin_unwind` into the dashboard fails arm 2. With the fix: 2 pass.
- Full suite: **301/301**.

## WP-3 — Persistence closure (4.13.6, code-only half)

**The defect:** persistence had happy-path tests only. A raw-write failure fell through
`classifyDependencyFailure`'s default branch, whose message — *"the telemetry record was
accepted but structured enrichment failed"* — asserted acceptance while
`rawPayloadPersisted` was `false`. Wrong in the direction that loses data: the caller reads
"accepted" and does not retry. `src/services/pipelineOrchestrator.ts:63-64`.

**Fix (code-only half):** the layer-3 raw write is wrapped so a failure becomes an explicit
`OperationalError('LEDGER_UNAVAILABLE', …, 503, { rawPayloadPersisted: false })` with a message
that claims no acceptance.

**Evidence:**
- `test/ingest-fails-closed.test.ts` — real router, real provisioned tenant, injected failing
  store: non-2xx `LEDGER_UNAVAILABLE`, `rawPayloadPersisted:false`, no success artefact, no
  claim of acceptance; plus a control that a healthy ledger is not named a ledger fault.
  **Failing-first:** old code answered `ENRICHMENT_DEGRADED` (3 pass / 1 fail); fixed 3/3.
- Full suite: **304/304**.

**Blocked half (named, not worked around):** "Appwrite persistence real / write survives
restart *against Appwrite*" needs a reachable Appwrite endpoint and a provisioned database.
`scripts/e2e-tenant-roundtrip.ts` (via `scripts/verify-storage-backend.sh --require-appwrite`)
is the harness; `fra.cloud.appwrite.io` times out from this host, so the real-backend write
path cannot be exercised here. Local durability/idempotency/restart are covered by
`test/founder-mode.test.ts` and `test/l4-durable-tenancy.test.ts`.

**Deferred honesty item (WP-3c):** the persisted transformation audit trail still carries
`circuitBreakerStatus: 'CLOSED'` (`src/models/telemetry.ts:42`,
`src/services/pipelineOrchestrator.ts:127`) although the Node pipeline runs no circuit
breaker. It is a schema field woven through the model and store, so removing it is its own
layer rather than a drive-by edit.

## WP-3c — Audit-trail honesty (4.13.7)

**Correction to the WP-2/3c framing:** the product *does* run a real circuit breaker
(`src/utils/circuitBreaker.ts`, guarding Gemini enrichment in `geminiService.ts`). The defect
was not a fictional breaker but a **fictional reading of it**: the orchestrator wrote the
constants `retryAttempts: 0` and `circuitBreakerStatus: 'CLOSED'`, so a retried, half-open
request was recorded as "no retries, breaker healthy". The Appwrite schema has a
`retry_attempts` column but no circuit-breaker column; both values travel inside the
`auditTrailJson` blob.

**Fix:** `GeminiService.transformTelemetry` now returns the attempt count from
`withExponentialBackoff` and the live `circuitBreaker.getState()`, and the orchestrator
records them. `TransformationAuditTrail` gained an explicit `'UNKNOWN'` state so a legacy row
is not typed with an `as never` lie.

**Evidence:**
- `test/orchestrator-audit-truth.test.ts` — real orchestrator, enrichment stub reporting
  `attempts: 3`/`HALF_OPEN`; the persisted record must carry those values. **Failing-first:**
  reverting the orchestrator to the constants fails it. Full suite: **305/305**.

## WP-4 — Cross-tenant read/write refusal (4.13.8)

**The defect:** the tenant registry routes were *unbound*. `GET /api/tenants` returned every
partition to any authenticated caller, and `GET /api/tenants/:id` read the id straight from the
path and returned that tenant's quota and guardrails — no check that the id was the caller's own.
`validateTenantRequest` inspects the header/body/query claim and never `req.params`, so it could
not have caught this even if the route had called it. Any root or admin-scoped credential could
enumerate every tenant and read any tenant's profile. That is precisely a *cross-tenant read*
failure — the WP-4 acceptance criterion.

**Fix (`src/api/routes/tenants.routes.ts`):**
- `GET /api/tenants` returns all partitions to a `platform_operator` only; a tenant credential
  sees exactly its own.
- `GET /api/tenants/:id` refuses with `TENANT_CREDENTIAL_MISMATCH` unless the id is the caller's
  own tenant or the caller is a `platform_operator`.

**Also corrected (auth-honesty, same WP):** `src/services/rbacService.ts` claimed in its class
doc that "`requirePermission` is the guard. It is called by routes" and that a permission-less
role "still cannot start a run". No such guard exists and `RbacService.check` is called by no
route — the enforced boundary is the credential-scope check in `tenantAuthMiddleware`. The doc
now states what is actually enforced and names route-level role enforcement as a tracked follow-up.
Shipping the false claim would be a protection the code does not provide.

**Evidence:**
- `test/wp4-cross-tenant-read.test.ts` — real router, real provisioned tenants: a tenant
  credential listing partitions sees only itself; reading another tenant by id is `403`
  `TENANT_CREDENTIAL_MISMATCH`; its own profile is `200`; a platform operator enumerates;
  `/api/telemetry/history` and `/api/telemetry/audit` refuse a foreign `?tenantId=`, answer
  their own. **Failing-first:** reverting `tenants.routes.ts` to HEAD fails the list-leak and
  read-by-id arms (2 fail / 5 pass); with the fix 7/7.
- `test/l4-durable-tenancy.test.ts` — added scoped-credential durability: a provisioned scoped
  key resolves after a simulated restart with its grant intact; a revoked scoped key stays
  revoked (`SCOPED_CREDENTIAL_REVOKED`). Closes the auth-durability proof for scoped keys, which
  the suite previously covered only for root keys.
- Full suite: **314/314**.

**Named open items (honest, not worked around):**
- **Rate-limit buckets are per-process.** `src/api/middleware/rateLimiter.ts` keeps a module-scope
  `Map`; a restart resets a tenant's window and N replicas each hold their own bucket. The limiter
  keys on the authenticated principal (not a caller-supplied header) and is HTTP-testable, so the
  *control* is real; only its *durability/sharedness* is not. Cross-replica limiting needs a shared
  store with an atomic token decrement — a follow-up, deliberately not faked.
- **RBAC role enforcement is not wired.** Roles/permissions are resolved and reported (`whoami`),
  and credentials are scope-enforced at the boundary; the role→permission layer is not yet called
  in front of routes (see `rbacService.ts`).

## WP-7 — Isolated execution boundary (4.13.9)

**The missing artifact was the record.** The factory runs commands on repositories it did not
author, and had three separate isolation mechanisms built at different times with different
strengths — but no ADR named the boundary, so the strongest was easily mistaken for the weakest.
`ADR-010: The execution boundary is bwrap, and escape is asserted` (Accepted) is that record.

**Two real code gaps closed alongside it:**

1. **The doctrine could disable the sandbox.** R-14 says verification commands "run sandboxed and
   fail closed; a command that cannot be sandboxed is refused, never run bare" — but
   `runCommand` (`src/services/groundTruthService.ts:135`) falls through to a bare `sh -c` when
   `sandbox.enabled` is false, and `parseLoopConfig` accepted `enabled: false`. R-14 was prose the
   code could be configured to break. `parseLoopConfig` now **refuses** a doctrine that disables
   the sandbox, so the only doctrine the loop loads has it on.
2. **Containment was a string prefix, not a real path.** `ExecutionBoundaryService.createManifest`
   and `SandboxPolicyService.createPolicy` compared `path.resolve` prefixes, which a symlink inside
   the workspace defeats. Both now use `pathGuard.resolveWithin` — whose own header names the
   duplicated-prefix check as the defect it exists to prevent.

**Honest scope (in ADR-010):** the three mechanisms are documented for what each actually provides.
`ExecutionBoundaryService` runs no bwrap and does not unshare the network (`network:'disabled'` is
a label); `SandboxPolicyService` executes nothing (`planRun` → `PLANNED`). The bwrap sandbox — used
by the loop's verify stage and the `no-op-unit` gate — is the strong boundary, and its escapes were
already refused by `test/loop-sandbox.test.ts`.

**Named open gap:** `verificationProfileService.executeVerification` (`:31`) runs unsandboxed and is
reachable from the live route `POST /api/factory-jobs/:id/verify` via `factoryJobService.verifyRepository`
(`:93`). It runs the target repo's own declared scripts (not caller argv), so the exposure is bounded,
but it is outside the boundary and not covered by R-14 today. Highest-priority follow-up: route it
through `runCommand` with the doctrine sandbox, or refuse when the sandbox cannot start.

**Evidence:**
- `test/wp7-execution-boundary.test.ts` — a doctrine with `sandbox.enabled:false` is refused; both
  boundary services refuse traversal and symlink escapes; `pathGuard` refuses absolute, traversal,
  and symlink escapes. **Failing-first:** reverting the doctrine guard fails arm 1; reverting the two
  services fails the symlink arms (2/6). Full suite: **320/320**.
- Docs moved with the code: `docs/adr/ADR-010-isolated-execution-boundary.md`, indexed in
  `docs/OPERATIONS.md`.

## WP-8 — Evaluation harness (4.13.10)

**The score existed; the measurement did not.** `FactoryJobService.recordLaunchQuality` already
persisted a 0–100 score, but every dimension was a function of *which metadata objects were
present on the job*, not of what the product actually did. A job whose verification failed but
whose evidence list happened to contain a `security-*` line still collected the 20 security
points. The number looked measured and was not — the exact class of false confidence this
sprint exists to remove.

**The harness is now a pure function of observed signals.** `src/services/productEvaluationService.ts`
exports `evaluateProduct(signals)`, which keeps the existing five dimensions and weights
(verification 25, security 20, evidence 20, operability 15, productDiscipline 20) so baselines
and history stay comparable, and:
- **fails closed** — an unobserved dimension scores 0, never full marks: no security scan
  observed is 0, not a pass; a verification "pass" carrying a failure class is treated as a
  failure;
- **reacts to real badness** — a `BLOCKED` security scan, a failed verification, an empty diff,
  a rejected adversarial review, and stuck units each zero or reduce their dimension;
- **names its deductions** — `reasons` lists every lost point, so a score can be argued with.

`recordLaunchQuality` now builds signals from the job and delegates. A `SECURITY` verification
failure is a real `BLOCKED` signal; metadata-only absence fails closed.

**Proof against a real artifact, not a fixture.** The test plants a high-severity AWS key in a
real temp git repo and runs the **real** `QualityGateService.scan`, which returns `BLOCKED`
(deterministic secret scan; no `package-lock.json`, so the network-bound audit is skipped), and
asserts the evaluated score is low. A seeded job with a brief, a plan, and a `security-*` evidence
line but a `SECURITY`-class verification failure scores `< 40` and persists that score.

**Evidence:** `test/wp8-product-evaluation.test.ts` (5 arms). **Failing-first:** reverting
`recordLaunchQuality` to the old presence-based rubric makes the known-bad job score 45 and fails
the e2e arm; reverting the evaluator's security fail-closed branch fails the known-bad, real-scan,
and e2e arms (3/5). Full suite: **325/325**.
