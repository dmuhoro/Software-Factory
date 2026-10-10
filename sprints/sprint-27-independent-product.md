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
