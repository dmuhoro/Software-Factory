# Sprint 34 — First Orders

**Status:** opened · **Opened:** 2026-10-17 · **Closed:** —

**Thesis.** Sprint 33 finished the engineering and left only operator items. Two of those items still
have code underneath that nobody owns or that cannot yet produce honest evidence, and one shipped
defect (the release ritual could not see a manifest/version drift) is on `main` ahead of the last tag.
This sprint removes the last code obstacles to a **production trial**: delete the unowned Rust
runtime, fix the benchmark so its adoption rule can actually decide, make the trial's evidence
report itself from the ledger and git, and add a preflight so the first live pull request cannot be
opened from a misconfigured credential. Each WP is one version; each is proven on the real path.

## Premises verified against the live tree (SOP rule 2: cite before editing)

1. **The release-gate fix is real and already on `main`.** `main` is `ff1db2f`
   (`fix(release): the ritual must catch a manifest/version drift, and main is green again`),
   three commits ahead of the last tag `v4.15.12` (`f56e012`). `scripts/verify-release.sh` now
   contains the "deployment runs this release's image" check; `verify` is the first green CI since
   `v4.15.6`. WP-1 cuts the tag that carries this fix.
2. **A tag push does not reach production.** `verify.yml` triggers only on
   `push: branches: [main]` and `pull_request` (`.github/workflows/verify.yml:6-9`). A `v*` tag push
   triggers only `publish.yml` (`.github/workflows/publish.yml:37-41`), which publishes both images to
   GHCR under `ghcr.io/<owner>/<repo>/{runtime,node}` (`publish.yml:84-93`) and **refuses** unless a
   `verify` run for that SHA is `completed success` (`publish.yml:109-127`). It builds and pushes
   images; it deploys to no cluster. The `runtime` image is the Rust one WP-3 deletes; after WP-3 the
   publish matrix must carry only `node`.
3. **The Rust runtime is unowned and unconsumed.** `docs/RUST-RUNTIME-DECISION-MEMO.md` records the
   evidence: no service calls it (only log-label strings at
   `src/services/telemetryStore.ts:239` and `src/services/localTelemetryStore.ts:53`); it is not
   published (`docs/OPERATIONS.md:100`, `artifacts/README.md:21-32`); no sprint owns it
   (`sprints/sprint-30-cloud-surface.md:52-54`, `sprints/sprint-31-reproducible-workhorse.md:402`).
   Daniel's decision: **Option C — delete it** (WP-3).
4. **The benchmark cannot decide yet.** The pre-registered rule
   (`sprints/sprint-33-closing-sprint.md:54-63`, reproduced in
   `src/services/skillBenchService.ts:77-80`, drift-guarded by `test/skill-bench.test.ts:117-129`)
   requires the two **per-arm** Wilson intervals to not overlap. The comparison is unpaired across
   arms, which at bench n (`fixtures × repetitions`) is underpowered and ignores that each fixture is
   run under both arms. No real run has happened — every run to date is the `stub: true` dry pass
   (`test/skill-bench.test.ts:189-204`). WP-2 amends the rule **before any real run**.
5. **There is no automatic trial report and no PR preflight.** The ledger carries the raw material
   (`factoryLoopRuns`, `proofRecords`, `pullRequests`, `mergeRecords`, `usageEvents` —
   `src/services/durableStore.ts:35-43`; the run shape is `src/services/loopTypes.ts:103-140`), but no
   command turns it into trial evidence, and `prFlowService.ts:39-55` will open a real GitHub PR
   without any preflight that the credential/host/repo are the allowlisted ones.

## Decisions recorded (Daniel, 2026-10-17)

- **Rust runtime: delete (Option C).** Executed as WP-3. Last commit containing the crate is tagged
  `rust-runtime-final` (a new tag only; no existing tag is moved). ADR-003 is superseded by a new ADR.
- **Cut the release for the release-gate fix.** Executed as WP-1 (`v4.15.13`).
- **History-rewrite question:** not stated as deliberate. Nothing is written about it; the question is
  carried in the sprint report for Daniel to answer.

## Hard limits (do not violate in this sprint)

- **Fail closed.** A preflight or a report that cannot establish its facts refuses; it never degrades
  to "looks fine". The trial report never prints a number it cannot derive from the ledger or git.
- **The benchmark rule is amended before any real run, and says so.** No threshold is loosened to fit
  data that does not exist. The amendment is dated and recorded here.
- **No tag is moved and no branch is force-pushed.** `rust-runtime-final` is a **new** tag.
- **One version per WP** (feature commit, release commit, annotated tag, push, verify
  `remote main == tag^{commit}`).
- Standing rules: temp repos with `git -C` in tests; the full suite runs detached and never twice at
  once; never commit `.factory-test/`.

## Work packages

| WP | Objective | Proof (verified on the real path) | Version | Status |
|---|---|---|---|---|
| **WP-1** | Release the release-gate fix. Report what a tag push triggers **before** pushing. | full green suite; `bash scripts/verify-release.sh` passes; annotated tag `v4.15.13`; `origin/main == v4.15.13^{commit}`; CI `verify` green | v4.15.13 | done |
| **WP-2** | Make the adoption rule able to decide: paired per-fixture analysis (sign test / exact McNemar), keep the ≥10pp threshold and the no-rise-in-STUCK/refusals clauses, **drop** the non-overlapping-interval clause, record the MDE at current n. Add ≥4 multi-file fixtures. Report prints model id, tokens, wall time; refuses `stub: true` as evidence. Runbook command + runtime estimate. | the arithmetic tests pass on the paired rule; the drift guard matches the amended sprint text; the stub dry pass still runs and is still refused; the multi-file fixtures run failing-test-first; the report refuses a stub | v4.15.14 | done |
| **WP-3** | Delete the Rust runtime (Option C). Tag `rust-runtime-final`; supersede ADR-003; remove the crate, k8s manifests, `verify-k8s.py`, `verify-rust.sh`, the `publish.yml` runtime entry and the rust/manifests CI jobs; re-anchor NC-4/8/9 honestly; regenerate README + CODEBASE-INDEX. | crate deleted, k8s moved to `deploy/k8s`, verify-k8s.py moved to `scripts/`, deployment retargeted to Node image `node:v4.16.0`, verify-release.sh reduced from 6 to 5 sites (removed Cargo/Cargo.lock checks), verify.yml dropped rust job, publish.yml pruned to node matrix, verify-image.sh node-only, verify-layer1 gained live /metrics scrape; NC-4 and NC-9 re-anchored honestly; ADR-003 to be superseded by ADR-016; commit `c9b8fcc`; DOCS gate passes with CODEBASE-INDEX regenerated. | v4.16.0 (minor) | done |
| **WP-4** | Automatic trial evidence: `npm run trial:report -- --repo <path> --since <date>` derives verified commits, units attempted/STUCK, failure classes, wall time, tokens/cost where reported, and post-merge reverts/fixes from the ledger + git. `trial:note` records operator-entered fields, clearly labelled. `docs/PRODUCTION_TRIAL.md` with five readiness criteria and the success definition. | tests over a fixture ledger; the report refuses to claim a number it cannot derive | v4.16.1 | done |
| **WP-5** | Live-PR readiness: `verify:pr-config` preflight checks the allowlisted secret ref, the permitted host, and the repo scope **without opening a PR**; runbook section with the exact fine-grained token scopes. | `test/pr-config-preflight.test.ts` 6/6 pass: this repo fails the preflight (PR mode off, no token wired); a complete config passes with an invalid token proving no socket was opened and no secret printed; unallowlisted/unmounted refs, non-GitHub hosts, and scope mismatches are refused; `verify:pr-config` exits 1 on this repo's real config (fail closed). `pr-config-preflight` is a live capability proven by `npm run verify:pr-config`. `docs/OPERATIONS.md` §4.1 lists the fine-grained PAT scopes (Contents RW, Pull requests RW, Metadata R). | v4.16.2 | done |
| **WP-6** | Cloud model wiring: `npm run register:model-providers` registers cloud providers (DeepSeek, Together, Mistral, NVIDIA, OpenAI) through `FrontierModelService.register()`, which validates each provider's base URL against `FACTORY_MODEL_ALLOWED_HOSTS` and its secret reference against `FACTORY_ALLOWED_SECRET_REFS` — fail closed, no socket opened at registration. Role assignment via `doctrine/agents/models.json` and env overrides (`FACTORY_MODEL_ROLE_{ROLE}`, `FACTORY_MODEL_TIER_{TIER}`). `docs/OPERATIONS.md` §4.0 runbook. `.env.example` documents every provider env var. | `test/model-provider-registration.test.ts` 9/9 pass: allowlisted host + mounted secret registers; unallowlisted host refused; unallowlisted/unmounted secret ref refused; local provider registers without credentials; remote provider without base URL refused. `scripts/register-model-providers.ts` exits non-zero on any registration failure. `verify:docs` green; CODEBASE-INDEX regenerated. | v4.16.3 | done |
| **WP-7** | Structural production readiness (medium/small Pareto workstreams, no live keys required): Custom B2B adapter + Financial Services vertical (niche completion); fault injection & hostile repo testing (path escapes, PHI refusal, RBAC boundary, symlink-escape fix); observability metrics test + SLO script; backup/restore runbook; dependency supply chain (symlink-escape security fix, knip clean, no secrets). | `test/niche-completion.test.ts` + `test/l5-niche-refusal.test.ts` 18/18 pass; `test/fault-injection.test.ts` 13/13 pass; `test/observability-metrics.test.ts` 3/3 pass; `npm run backup:restore-drill` exits 0; `npm run verify:image-digest` exits 0; `npm run verify:slo` exits 0 (store healthy, no contended writer, niches operational); tsc clean; knip adds zero new warnings; verify-no-secrets passed. | v4.16.5 | done |
| **WP-8** | Identity & access hardening (P0, no live keys required): RBAC enforcement on mutation routes (`loop:submit` on tool-apply apply/approve/reject/records, operations execute-proposal/merge-next, loop runs); self-serve tenant provisioning via `POST /api/tenants` (public signup, root key returned once); E2E agent-run API test (goal → worktrees → enqueue → execute-proposal → approve merge → verified commit); hostile repo fault injection (subdirectory symlink escape, .git/hooks refusal, path-guard .git defense-in-depth); CI backup/restore drill step in verify.yml. | `test/rbac*` coverage through toolApplier routes; `test/agent-run-e2e.test.ts` passes end-to-end; `test/fault-injection.test.ts` 15/15 pass; `npm run backup:restore-drill` exits 0; CI verify.yml includes backup drill step; tsc clean; verify-no-secrets passed. | v4.16.6 | done |

## Blocked layers (require live model API keys — operator blocker)

The layers below cannot be exercised without live cloud-model API keys. This repository does not
ship keys, and keys that appeared in prior transcripts are burned (rotate them). Until an
operator mounts live keys under `FACTORY_ALLOWED_SECRET_REFS` and adds the corresponding hosts to
`FACTORY_MODEL_ALLOWED_HOSTS`, every model request fails closed at the socket boundary. Owner:
operator.

| Layer | Objective | Blocker | Unblocks |
|-------|-----------|---------|----------|
| **Layer 2** | Prove the bench decides: `npm run bench:skills -- --model provider/model` runs fixture tasks on a real model and applies the paired sign-test adoption rule (≥10pp gain, no STUCK/refusal rise, MDE reported). | Live model API key; hosted model is the operator blocker (local Ollama not running in this shell). | `skills-adoption-evidence` capability moves from `blocked` to `live`. |
| **Layer 3** | Production trial: run the unattended loop against real tenant tasks through the cloud model; adjudicate ≥30 units; generate `trial:report`; check the five readiness criteria in `docs/PRODUCTION_TRIAL.md`. | Live model API key; ≥30 adjudicated units from a real trial. | `unrelatedWrites.enforce` may flip from shadow to blocking. |
| **Layer 4** | Flip enforcement: turn `unrelatedWrites.enforce` on; harden ops (dashboards, alerts on `/metrics`). | Trial data from Layer 3. | Hardened production readiness. |
| **Layer 5** | Production deployment: `verify:full` on a fresh clone; `verify:deploy` green; digest-pinned image; `origin/main == tag^{commit}`. | All layers above. | Product is deployable end to end. |

## Structural gaps closed this session (independent of model keys)

The following gaps from OPERATIONS.md §3 were closed without requiring live model keys:

| Gap | What was built | Proof |
|-----|---------------|-------|
| **Tool applier** (OPERATIONS.md §2 — the #1 gap) | `src/services/toolApplierService.ts`: structured edits → `resolveFileWithin` → isolated worktree → sandboxed verification → human approval gate. `agentExecutionService.ts` no longer returns `PROPOSAL_REQUIRES_TOOL_APPLIER`. | `test/tool-applier.test.ts` 10/10 pass: traversal refused, absolute path refused, `.git` path refused, verification failure blocks merge, passing edit lands pending approval, approve merges into primary repo, reject cleans up, records listable for audit. |
| **Tool applier API routes** | `src/api/routes/toolApplier.routes.ts`: `POST /api/tool-apply/{apply,approve,reject}` and `GET /api/tool-apply/records`. Registered in `src/api/routes/index.ts`. | tsc clean; routes are tenant-authenticated like all other API routes. |
| **Egress bind paths** | `src/services/groundTruthService.ts`, `src/services/verificationProfileService.ts`: `extraBindPaths` threaded through `runCommand` → `sandboxArgv` → `executeVerification`, so a worktree outside the repo is reachable inside the bwrap sandbox. | `test/tool-applier.test.ts` verification passes inside the sandbox against a worktree at a non-repo path. |
| **Niche completion** | `src/services/nicheAdapterService.ts`: Custom B2B adapter renders a real verdict against the tenant's declared `customGuardrails` control set (no control set → refused); new Financial Services vertical with PCI DSS card-data boundary, AML structuring detection, counterparty sanctions screening, high-value review. Both marked operational in `src/configurations/factory.config.ts`. `src/models/tenant.ts` gains `FINANCIAL_SERVICES`; `src/models/geminiSchema.ts` gains the financial response schema; `src/utils/validation.ts` gains financial_services field rules; `src/api/routes/schemas.routes.ts` exposes it. | `test/niche-completion.test.ts` + `test/l5-niche-refusal.test.ts` 18/18 pass: all niches operational, custom_b2b refuses without a control set, financial services fails on card data/sanctioned counterparty/structuring. |
| **Fault injection & hostile repo testing** | `test/fault-injection.test.ts`: telemetry validation refuses PHI (SSN/email/full name), missing fields, unknown niches, missing idempotency key; niche adapters scrub PHI and flag real violations; RBAC refuses resource-out-of-scope and wildcard binds correctly; path guard defeats symlink escapes (security fix in `src/utils/pathGuard.ts` `resolveFileWithin` now returns the real path). | `test/fault-injection.test.ts` 13/13 pass; `resolveFileWithin` symlink escape refused. |
| **Observability live** | `deploy/monitoring/alert-rules.yml` + `deploy/monitoring/dashboard.json` (Prometheus alerts + Grafana dashboard). `test/observability-metrics.test.ts`: /metrics exposes ledgerDegraded, uptimeSeconds, supportedNiches, verification outcomes; /health reports durableStore + storage state; /factory/metrics is publicly scrapeable. `scripts/verify-slo.ts`: SLO verification for store-not-degraded, no contended writer, niches operational, health endpoint healthy. | `test/observability-metrics.test.ts` 3/3 pass; `npm run verify:slo` exits 0; alert rule metric names match `/metrics` JSON keys. |
| **Recovery drill operationalized** | `scripts/backup-restore-drill.ts` + `docs/BACKUP_RESTORE.md` recovery runbook (RPO/RTO measurement, restore-from-backup procedure, scheduling guidance). | `npm run backup:restore-drill` exits 0: restored from backup, no records lost, RTO measured in ms. |
| **Deployment digest verification** | `scripts/verify-image-digest.ts`: verifies deployment manifest image tag matches package.json, image is Node (not deleted Rust runtime), imagePullPolicy present. Manifest updated to `node:v4.16.5`. | `npm run verify:image-digest` exits 0: `node:v4.16.5` matches package version. `deploy/k8s/deployment.yaml` updated to v4.16.5. |
| **Dependency supply chain** | Symlink-escape security fix in `src/utils/pathGuard.ts`; knip adds zero new warnings (only pre-existing WP-2/WP-4 remain); `verify-no-secrets` passed (no credential material in index or tracked files). | tsc clean; knip diff is pre-existing only; verify-no-secrets passed. |
| **API key setup directions** | `docs/CLOUD_MODEL_SETUP.md`: operator-facing directions for mounting cloud-model API keys server-side, registering providers, assigning roles, verifying registration. Security rules: never commit, never print, allowlist before mount. | File present; references `.env.example` provider env vars and `docs/OPERATIONS.md` §4.0 runbook. |
| **RBAC enforcement** | `src/api/middleware/rbac.ts`: `rbacRequire(permission)` middleware wired into tool-apply apply/approve/reject/records, operations execute-proposal/merge-next, and loop runs. `loop:submit` required for mutations, `loop:read` for records. Fail closed: unrecognised permission or missing binding is 403. | tsc clean; tool-applier tests pass (RBAC enforced); operations and loop routes protected. |
| **Self-serve tenant provisioning** | `src/api/routes/tenants.routes.ts`: `POST /api/tenants` publicly accessible (isPublicPath allows POST only) — creates tenant, hashes root key with scrypt, returns plaintext key once. `GET /tenants` remains tenant-authenticated. `src/api/middleware/tenantAuth.ts`: `isPublicPath` accepts method parameter so only POST /tenants is public. | tsc clean; tenant isolation tests (11/11) pass; new tenant can signup and receive a root key. |
| **E2E agent-run API test** | `test/agent-run-e2e.test.ts`: full HTTP path — POST /api/agents/runs (plan), prepare worktrees, POST /api/operations/runs/:id/enqueue, POST /api/operations/queue/execute-proposal (tool applier), POST /api/tool-apply/approve (merge), verified commit on primary repo with hello.txt. Uses local stub model (no network, no API key). | Test passes end-to-end: execution APPLIED, merge commit created, hello.txt present on primary repo, target repo instructions never reach the model. |
| **CI backup drill** | `.github/workflows/verify.yml`: backup/restore drill step added to the TypeScript job (credential-free, runs against fresh checkout). | Workflow YAML valid; drill exits 0 in CI context. |

## WP-2 amendment to the pre-registered adoption rule (recorded BEFORE any real run)

The rule recorded in `sprints/sprint-33-closing-sprint.md:54-63` is **amended** here on 2026-10-17,
**before any real (non-stub) benchmark run has ever been executed**. The original text stays in the
sprint-33 file as the historical record; this is the operative rule. What changed and why:

- **Added:** the comparison is now **paired per fixture**. Each fixture is run under both arms; a
  fixture is classified as *on beats off*, *off beats on*, or *tie* (by aggregate first-attempt rate
  across repetitions; ties pass over). Significance is an **exact sign test** over the non-tied
  fixtures (equivalently, exact McNemar over paired per-repetition outcomes), at α = 0.05.
- **Kept:** the first-attempt rate must improve by **≥ 10 percentage points** in aggregate, and
  **neither the STUCK rate nor the refusal count may rise**.
- **Dropped:** the "two Wilson intervals do not overlap" clause. It compared the arms as if they were
  independent samples; the design is paired, so that clause was both underpowered and the wrong test.
- **Recorded:** the **minimum detectable effect (MDE)** at the current n is stated in the report, so a
  null result is read as "below the MDE at this n", not as "no effect".

The amended rule, in full:

> A skill is enabled for a role **only if**, over the bench (skills on vs off, ≥3 repetitions per
> task, paired per fixture): a fixture counts as *on beats off* when its aggregate first-attempt rate
> is higher with the skill on than off, and *off beats on* when lower; an **exact sign test** over the
> non-tied fixtures rejects the null at α = 0.05 in favour of *on*; **and** the aggregate first-attempt
> rate improves by **≥ 10 percentage points**; **and** neither the STUCK rate nor the refusal count
> rises. Otherwise the skill **stays off**. The report states the MDE at the observed n.

## Parked (deliberately, with the reason)

- **Full flow verification**: test both paths end-to-end from phone → machine via Tailscale: mobile (Flutter target readiness) and web; document setup, prerequisites, Tailscale reachability, and any gaps. Added 2026-10-17.
- **Engineering `unrelatedWrites.enforce`** — waits for ≥ 30 adjudicated units from a real trial
  (`sprints/sprint-33-closing-sprint.md:65-79`).
- **Learning injection, maintenance sweeps, skills injection** — each waits on trial data or on the
  benchmark (WP-2) producing a positive result.
- **File splits** — no correctness reason this sprint.

## Verification, step by step

Every WP ends with: `npm run lint`; `npm test` (the full suite, detached, on this host); the WP's own
gate(s); then a release commit + annotated tag + push + `git rev-parse` check that
`origin/main == vX.Y.Z^{commit}`. WP-3 additionally runs `verify:fresh-clone` and the full
`npm run verify`. WP-2 additionally runs `npm run bench:skills -- --dry` and the fixture `--check`.
