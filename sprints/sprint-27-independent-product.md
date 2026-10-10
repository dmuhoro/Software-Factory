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
`process.memoryUsage()` actually produce. *(See WP-2 completion below.)*
