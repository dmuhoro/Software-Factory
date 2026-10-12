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
| WP-5 | Operator caps & audit (renumbered by operator directive; the original "model productionisation" stays behind its hosted-model-key input) | operator cap overrides enforced and audited (4.13.15) |
| WP-6 | Daily AI-token budget guard (renumbered by operator directive; the original "repository tooling / PR flow" stays behind its GitHub input) | a spent tenant is refused with 429 before the model is called |
| WP-7 | Isolated execution boundary (ADR + doctrine) | ADR accepted; escape test refused; live verify path sandboxed (4.13.18) |
| WP-8 | Evaluation harness scoring generated products | harness scores a known-bad product low |
| WP-9 | CI/CD, backups, restore + load tests | restore returns the data; pipeline is the gate |
| WP-10 | Scale & economics: queue isolation, budgets, metering | metering matches usage; per-tenant queue isolation holds; daily-token budget enforced (WP-6) |
| WP-11 | One real customer wedge | an outcome metric beats the incumbent |

WP-6 … WP-11 depend on operator inputs that are not code: a GitHub App/token, a
hosted model key with spend, Appwrite provisioning, and a chosen customer. They
are sequenced but cannot be *completed* without those inputs; the blocker is
named in each case rather than worked around.

**Renumbering (operator directive):** the *code* halves of the blocked packages
are being delivered under adjusted numbers — WP-6 is now the daily AI-token
budget guard (the enforcement WP-10 part 1 explicitly deferred) and WP-5 is the
operator caps & audit layer. The original WP-5 (model productionisation) and
WP-6 (PR flow) remain blocked exactly as recorded above; renaming the number
does not silently resurrect them.

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

**Closed — the named open gap (4.13.18):** `verificationProfileService.executeVerification` called
`execFileSync` directly, reachable from the live route `POST /api/factory-jobs/:id/verify` via
`factoryJobService.verifyRepository`. It now builds each profile step as a shell command and routes
it through `runCommand` with the doctrine sandbox, so a repo whose profile cannot be sandboxed is
refused. Verified by `test/wp7-verify-profile-sandbox.test.ts` (6 arms). While wiring it, two real
defects in the same path were fixed rather than papered over:
- **the verification process inherited `{ ...process.env }`** — `sandboxArgv` copies every entry
  onto the bwrap argv, putting live credentials in a world-readable command line; it now receives
  `DoctrineIsolationService.childEnv(...)`;
- **a failed sandbox command dumped its own argv** — `runCommand` fell back to `error.message`
  (`Command failed: <bwrap> <argv…>`) when a command exited non-zero with no output, and the loose
  `TYPECHECK` regex (`/type|tsc|compile/`) read a stray `NODE_ENV=test` as a `TEST` failure; the
  fallback is now a bounded, argv-free condition and the classifier requires a real typecheck token.

**Evidence:**
- `test/wp7-execution-boundary.test.ts` — a doctrine with `sandbox.enabled:false` is refused; both
  boundary services refuse traversal and symlink escapes; `pathGuard` refuses absolute, traversal,
  and symlink escapes. **Failing-first:** reverting the doctrine guard fails arm 1; reverting the two
  services fails the symlink arms (2/6). Full suite: **320/320**.
- `test/wp7-verify-profile-sandbox.test.ts` (6 arms) — the 4.13.18 follow-up: a missing bwrap binary
  refuses; a real profile runs sandboxed; the service contains no `execFileSync`/`spawn`; the spawned
  process does not see an ambient `SF_LEAK_CANARY`; a failed step is named with no `--setenv` or
  `Command failed:` in the output. **Failing-first:** forwarding `process.env` fails the no-inherit
  arm; restoring the `error.message` fallback fails the no-dump arm; reverting the routing fails the
  source-invariant arm. Full suite: **359/359**.
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

## WP-9 — CI/CD, backups, restore, and load (4.13.11)

**Most of this package already existed, and the honest work was to prove it, not rebuild it.**
`.github/workflows/verify.yml` is a real gate — it runs `actionlint`, the Appwrite scope check,
typecheck, `npm test`, build, layers 1–4 over HTTP, storage-backend selection, the secret gate, the
release-record check, the integration and docs checks, the KB-MCP self-test, and the Rust
fmt/clippy/tests. A checksummed `WorkspaceService.backup`/`restore` already existed, routed at
`POST /api/workspace/backup` and `POST /api/workspace/restore/:backupId`.

**Two real gaps remained, and both were proof gaps:**

1. **Restore was never shown to return the data.** The existing test asserted only that the stored
   *checksum* came back — it would have passed if `restore` never swapped the live document. The
   test now creates a job *after* the backup, restores, and asserts that post-backup job is **gone**
   while the original remains. **Failing-first:** deleting `DurableStore.replaceDocument(data)` from
   `WorkspaceService.restore` fails it.
2. **No load test existed.** `test/wp9-load.test.ts` boots the real app on an ephemeral port and
   fires **60 concurrent** `POST /api/factory-jobs`, asserting all succeeded, the ledger holds
   exactly 60 unique records, and they survive a drop-and-re-hydrate from disk. **Failing-first:**
   a store that drops an interleaved write fails the count assertion.

**Pipeline is the gate.** Both tests run under the `npm test` step that `verify.yml` already
executes, so CI gates them without a new job. Single-writer correctness across processes was
already proven by `test/durable-store-writer-lock.test.ts`. Full suite: **326/326**.

## WP-10 — Scale & economics: metering, budgets, queue isolation (4.13.12, part 1)

**The declared budget had no reader.** Every tier carries `maxDailyAiTokens`
(`factory.config.ts:97-109`, `models/tenant.ts:27`), and nothing anywhere metered or enforced it.
Building that meter on the numbers the code reported was impossible, because they were fabricated:
the deterministic fallback claimed `tokensUsed: 420` and the live path defaulted to `|| 512` when
the provider returned no usage metadata.

**The meter (`src/services/usageMeteringService.ts`)** records only observed usage, per tenant per
UTC day, in a new durable `usageEvents` collection (ledger v5 → v6, additive migration). It refuses
a figure that is not a non-negative integer (`USAGE_TOKENS_INVALID`) rather than rounding it, and is
idempotent on `(tenant, source, correlationId)` through `DurableStore.deterministicId`, so a retry
cannot double-count. `geminiService` now reports `0` on the fallback and
`result.usage?.totalTokenCount ?? 0` on the live path; the orchestrator meters the enrichment's
reported tokens each cycle, keyed on the correlation id. `GET /api/usage` reports the caller's own
consumption and answers for the authenticated principal only.

**Scope decision (operator-approved).** Metering is built now; **enforcement of the daily token
budget is deferred** to WP-5, because a budget can only be honestly exercised against real model
usage. This layer measures; it does not yet cap. That is recorded here rather than faked.

**Evidence:** `test/wp10-usage-metering.test.ts` (7 arms) — exact day totals, cross-tenant
non-leakage, idempotency, invalid-figure refusal, fallback-honesty, no-fabricated-constant
source invariant, orchestrator wiring, and the self-only route. **Failing-first:** restoring
`tokensUsed: 420` fails the honesty arms (2/7); removing the orchestrator record call fails the
wiring arm; breaking idempotency fails the retry arm. `l4-durable-tenancy.test.ts` gains a v5 → v6
migration arm. Full suite: **334/334**.

**Still open in WP-10 (part 2):** per-tenant queue isolation / fair-share concurrency. Today
`ResourceGovernorService.admit` (`executionLoopService.ts:346`) caps **global** host concurrency;
there is no per-tenant cap and no fair-share, so one tenant's runs can consume the whole budget.
That needs cross-run per-tenant in-flight tracking and a tier-derived cap, and is a distinct
concern from metering — the next layer.

## WP-10 (part 2) — Per-tenant queue isolation and fair-share (4.13.13)

**The isolation gap.** `ResourceGovernorService.admit` caps *host* concurrency but has no notion
of who is asking. One tenant with many repositories could take every admitted slot, so the global
cap was a race, not a guarantee. That was more than an SLA concern: a bursty tenant could hold the
host at full parallelism while every other tenant's submissions piled up behind it, with no tenant
warning that anything was amiss.

**`src/services/tenantQueueService.ts`** — admission is decided before any work starts, on three
rules that each fail closed:
- **Tier-derived cap.** A `starter` tenant holds one concurrent run, `professional` two,
  `enterprise` four. `FACTORY_TENANT_CONCURRENCY` may only tighten, never loosen past the tier.
- **Fair-share.** A tenant holds at most `floor(globalCap / competitors)` of the host's admitted
  slots, where `competitors` is the number of distinct tenants holding a slot plus this one. Alone
  on the host a tenant may use its whole tier cap; the moment a second tenant arrives neither can
  grow past half. Non-preemptive by design: a run already holding a slot is never killed, the
  division takes effect on the next admission.
- **Unknown principal = conservative cap.** A tenant the registry does not know has no tier to
  divide by, so it is capped like a `starter`, never waved through.

**Wired at the live boundary**, not beside it: `LoopControlService.submit` (the path every HTTP
and CLI submission goes through) reserves a per-tenant slot before the loop starts, keyed by a
generated lease id, and releases it when the run settles — and on the path where a run refuses
before creating a record. A tenant at its share is refused `TENANT_CONCURRENCY_LIMIT` (409) by
name, with the reason (tenant cap, host cap, or both) in the detail; the client decides whether to
wait or to shed load. No silent queueing.

**Honest scope, named not faked:** in-flight tracking is process-local, exactly like loop
cancellation — "in flight" is a fact about this process's execution and needs nothing persisted
between restarts. A multi-replica deployment would need a shared counter with an atomic
decrement, which is a follow-up.

**Evidence:** `test/wp10-tenant-queue.test.ts` (6 arms) — tier caps for all three tiers plus the
unknown-tenant cap; the host cap winning over the tier; two competing tenants each held to their
fair share while the host fills; release freeing a slot; and the real submission path reserving a
slot, refusing a second repository for the same tenant with `TENANT_CONCURRENCY_LIMIT`, freeing
the slot on settle, and admitting again. **Failing-first:** removing the `TenantQueueService.acquire`
call in `submit` lets the overloaded submission through (integration arm fails); removing the
settle-path release leaves `inFlightCount` at 1. Full suite: **340/340**.

## WP-6 (as renumbered) — the daily AI-token budget is enforced at the spend boundary (4.13.14)

WP-10 part 1 built the meter and explicitly did *not* cap: "a budget can only be honestly
exercised against real model usage." The meter was exactly that — a number with a reader and
no wallet. This layer ties the number to the boundary that spends.

**`PipelineOrchestrator.execute` now refuses a cycle before it calls the model** when the
tenant's metered consumption for today already meets or exceeds `maxDailyAiTokens`
(`usageMeteringService.budgetState` + the guard immediately before the Gemini call). The
refusal is a `429` (`AI_BUDGET_EXCEEDED`) with a `Retry-After` that reaches the next UTC
midnight, so a client can obey it, and the refused cycle **never calls the model**, records no
metered spend, and writes no transformation record.

Three decisions deserve recording:

- **The check sits at the spend boundary** — right before enrichment, after the raw record is
  durable — not in a helper nothing real calls. A single model call can still overshoot the
  remaining allowance (its cost is unknowable until it returns); the guarantee the quota can
  honestly make is *no further spend once the day's allowance is gone*.
- **Fail closed.** A tenant with no measurable allowance (`reason: 'unknown'`/`'unset'`) is
  refused (`AI_BUDGET_UNKNOWN`, 500) rather than run unbudgeted. A tenant whose profile vanished
  mid-request gets the same treatment. "No budget" never means "unlimited".
- **The meter stays the source of truth.** `budgetState` answers *is it spent?* against the
  durable `usageEvents` ledger; it does not pretend to reserve or atomically decrement a balance it
  does not own.

**Evidence:** `test/wp6-budget-guard.test.ts` (5 arms) — under-budget runs and is metered;
a spent tenant is refused before the model is called (429, Retry-After within a day, no
transformation record, no added spend); `consumed == allowance` counts as spent; an unknown
principal fails closed as `unknown`, never unlimited; and the **live** `POST /api/telemetry/ingest`
answers a spent tenant with `429` + `AI_BUDGET_EXCEEDED` + `Retry-After` on the wire.
**Failing-first:** deleting the guard lets a spent tenant reach the enrichment stub; a
`budgetState` reporting `exhausted: false` for a full tenant fails the retaliation arm. Full
suite: **345/345**.

## WP-5 (as renumbered) — operator caps & audit controls (4.13.15)

Concurrency was tier-derived in code (`TenantQueueService`) and tokens quota-derived at
registration; neither could be changed at runtime, and a change to either would have been
silent. This layer is the operator's durable handle on both.

**`OperatorCapService`** persists a per-tenant override (`concurrency`, `dailyAiTokens`) in the
durable ledger (new `operatorCaps` collection; ledger bumped to v7 with the same additive
migration as `usageEvents`), attributable via `updatedBy` and a bumping `revision`.

- **Tighten-only by construction, not by convention.** `set` refuses a value above the base
  re-derived from the live tenant profile (`OPERATOR_CAP_NOT_TIGHTENING`), and every consumer
  reads the effective cap as `Math.min(base, override)` — so even a stale override that slips
  past validation can only shrink a cap, never grow it. `clear` restores the base.
- **Enforced on the real paths.** `TenantQueueService.limitFor`/`admit` bind the concurrency
  boundary; `usageMeteringService.budgetState` binds the allowance the daily budget is enforced
  against. An override that changed a database row but not those boundaries would be a column
  nobody reads.
- **Operator-only, audited.** `POST/DELETE /api/operator/tenants/:id/caps` require a
  `platform_operator` principal (`OPERATOR_ROLE_REQUIRED`); every successful change writes a
  `tenant.cap.change` audit event (action `set`/`clear`, actor, revision) into the store's
  durable audit trail via `recordAuditEvent`.

**Evidence:** `test/wp5-operator-caps.test.ts` (6 arms) — tighten-only refusal (above-base,
empty, negative, and against an unmeasurable allowance); a written cap is durable across a
store reload, attributable, and binds `limitFor`/`budgetState` (with `clear` restoring the
base); a rogue override planted directly in the ledger clamps to `min` and cannot raise a cap;
live route: a tenant credential is refused 403, a platform operator's `POST`/`DELETE` apply the
cap and leave audit events, and `GET` reports the effective state. Also new ledger collection +
v7 migration, `DurableStore.delete`, and `l3-error-contract` registration of
`OPERATOR_ROLE_REQUIRED`/`OPERATOR_CAP_INVALID`/`OPERATOR_CAP_NOT_TIGHTENING`/
`TENANT_NOT_FOUND`/`OPERATOR_ACTOR_REQUIRED`. Full suite: **351/351**.

## Hardening — v7 migration arm & the WP-7 secret gate (4.13.16)

Two gates the sprint promises to keep green were made genuinely green, not assumed green.

**Ledger migration ladder completed.** `test/l4-durable-tenancy.test.ts` gains the
version-6 → 7 arm, so every version the build still accepts (v4 → v7) has a test proving it is
read, migrated forward, and rewritten at `LEDGER_VERSION`, with the new `operatorCaps`
collection coerced to empty rather than absent. The additive-migration claim is now exercised,
not asserted.

**The WP-7 secret gate was red before this sprint.** `scripts/verify-no-secrets.sh` flags
provider token shapes in the git index; the WP-8 fixture plants the AWS *documented example* key
`AKIAIOSFODNN7EXAMPLE` deliberately (to prove the product secret-scan detects it), which matched
the `AKIA[0-9A-Z]{16}` pattern. Every secret shape the product scan detects is also a gate
pattern, so the fixture could not be reworded without weakening the arm. The gate now exempts
**only** that vendor-published example value, and only in a file where *every* AWS-shaped match
is it; a file containing any other `AKIA…` value is still blocked, proven with a planted-real-key
negative control. This is a targeted exemption of a value AWS documents as unusable, not an
exemption of tests or of the pattern. Full suite: **352/352**; the gate passes.

## Hardening — record-id collision & the WP-7 verification path (4.13.17–4.13.18)

**A meter that quietly dropped events.** `DurableStore.id` hashed `${entropy}:${Date.now()}:${pid}`.
When a caller's `entropy` is itself a millisecond timestamp — `UsageMeteringService.record` passes
the event's ISO time — two records minted in the same millisecond hashed to one id, and `record`
read the second as a replay and discarded it: usage was undercounted, and WP-6's daily token budget
was enforced against that undercount. `id` now folds a monotonic per-process counter into the digest
(`deterministicId` is untouched). **Failing-first:** removing the counter collapses a 50-event burst
below fifty. Full suite: **353/353**.

**The last bare execution path is closed, and it no longer leaks.** Routing
`verificationProfileService.executeVerification` through the doctrine sandbox (above) was the ADR-010
follow-up. Two defects found on that path were fixed at the boundary: the verification process no
longer receives `{ ...process.env }` (which `sandboxArgv` would copy onto a world-readable argv), and
`runCommand` no longer persists `error.message` — the whole bwrap command line — as failure output.
See the WP-7 evidence above. Full suite: **359/359**.
