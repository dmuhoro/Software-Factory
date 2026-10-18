# Changelog - Software Factory Multi-Tenant B2B SaaS Platform

All notable architectural and code modifications are documented here.

## [Unreleased]

## [4.16.6] - 2026-10-18 — Identity & access hardening

### Added
- **RBAC enforcement on mutation routes (Sprint 34, WP-8).** `src/api/middleware/rbac.ts`: `rbacRequire(permission)` middleware wired into tool-apply apply/approve/reject/records (`loop:submit` / `loop:read`), operations execute-proposal/merge-next (`loop:submit`), and loop runs (`loop:submit`). Fail closed: unrecognised permission or missing binding is 403.
- **Self-serve tenant provisioning (Sprint 34, WP-8).** `POST /api/tenants` is publicly accessible — creates a tenant, hashes a root API key with scrypt, returns the plaintext key exactly once (never stored, logged, or recoverable). `GET /tenants` remains tenant-authenticated. `isPublicPath` accepts a method parameter so only `POST /tenants` is public.
- **E2E agent-run API test (Sprint 34, WP-8).** `test/agent-run-e2e.test.ts`: full HTTP path — plan run → prepare worktrees → enqueue → execute-proposal (tool applier) → approve merge → verified commit on primary repo. Uses a local stub model (no network, no API key).
- **CI backup/restore drill (Sprint 34, WP-8).** `.github/workflows/verify.yml`: backup/restore drill step added to the TypeScript job, measuring RPO/RTO on every change.
- **Fault injection hardening (Sprint 34, WP-8).** `src/utils/pathGuard.ts` `resolveFileWithin` now refuses `.git` paths at the guard boundary (defense in depth). `test/fault-injection.test.ts` (15 tests): symlink in subdirectory pointing outside refused; `.git/hooks` path refused; telemetry PHI refusal; RBAC resource boundary.

## [4.16.5] - 2026-10-18 — Structural production readiness (Pareto workstreams)

### Added
- **Niche completion (Sprint 34, WP-7).** Custom B2B adapter now renders a real compliance verdict against the tenant's declared `customGuardrails` control set (refuses with no control set — no fabricated SOC2 evidence). New Financial Services vertical with PCI DSS card-data boundary, AML structuring detection, counterparty sanctions screening, and high-value-transaction review. Both marked operational. `doctrine/agents/models.json` role assignment applies to all niches. `test/niche-completion.test.ts` and `test/l5-niche-refusal.test.ts` (18 tests) prove all niches operational, custom_b2b refuses without a control set, financial services fails on card data/sanctioned counterparty/structuring.
- **Fault injection & hostile repo testing (Sprint 34, WP-7).** `test/fault-injection.test.ts` (13 tests): telemetry validation refuses PHI (SSN, email, full name), missing fields, unknown niches, missing idempotency key; RBAC refuses resource-out-of-scope access; path guard defeats symlink escapes via a security fix in `src/utils/pathGuard.ts` `resolveFileWithin` (now returns the real path so a symlink target outside the repo is refused).
- **Observability live (Sprint 34, WP-7).** `test/observability-metrics.test.ts` (3 tests) proves `/metrics` exposes ledgerDegraded, uptimeSeconds, supportedNiches and verification outcomes that the alert rules in `deploy/monitoring/alert-rules.yml` depend on; `/health` reports durableStore + storage state; `/factory/metrics` is publicly scrapeable. `scripts/verify-slo.ts` verifies SLOs: store not degraded, no contended writer (NC-2), niches operational, health endpoint healthy.
- **Backup/restore operationalized (Sprint 34, WP-7).** `docs/BACKUP_RESTORE.md` recovery runbook with measured RPO/RTO, restore-from-backup procedure, and scheduling guidance. `npm run backup:restore-drill` exits 0: restored from backup, no records lost.
- **Dependency supply chain (Sprint 34, WP-7).** `scripts/verify-image-digest.ts` updated to v4.16.5; `deploy/k8s/deployment.yaml` image pinned to `node:v4.16.5`. knip adds zero new warnings; `verify-no-secrets` passed (no credential material committed).

## [4.16.4] - 2026-10-18 — Structural gaps closed

### Added
- **Tool Applier Service (Sprint 34, structural gap #1).** `src/services/toolApplierService.ts` bridges model output to durable change: structured edits (`path`, `operation`, `content`) are validated through `resolveFileWithin`, applied in an isolated git worktree, verified sandboxed against the repository's own verification contract, and gated behind a human approval (`MODIFY_BRANCH`) before merge. `agentExecutionService.ts` no longer returns `PROPOSAL_REQUIRES_TOOL_APPLIER` — it now applies verified edits and requests approval. API routes at `POST /api/tool-apply/{apply,approve,reject}` and `GET /api/tool-apply/records`. `test/tool-applier.test.ts` (10 tests) proves traversal refusal, verification-blocked merge, passing edit lands pending approval, approve merges into primary repo, reject cleans up. `groundTruthService.ts` / `verificationProfileService.ts` thread `extraBindPaths` through the bwrap sandbox so a worktree outside the repo is reachable at verification time.

### Added
- **Observability alerting rules.** `deploy/monitoring/alert-rules.yml` — Prometheus alerts for ledger degradation, contended writer (NC-2 single-writer violation), verification failure rate, STUCK units, memory pressure, and process restart. `deploy/monitoring/dashboard.json` — Grafana dashboard structure.
- **Recovery drill.** `scripts/backup-restore-drill.ts` — measures RPO/RTO by corrupting the ledger, triggering `DurableStore` recovery, and recording restore-from-backup, records-lost, and recovery time. `npm run backup:restore-drill` exits 0: restored from backup, no records lost.
- **Deployment digest verification.** `scripts/verify-image-digest.ts` — verifies `deploy/k8s/deployment.yaml` image tag matches package.json, image is Node (not deleted Rust runtime), `imagePullPolicy` present. Manifest updated to `node:v4.16.3`.
- **Cloud model setup directions.** `docs/CLOUD_MODEL_SETUP.md` — operator-facing directions for mounting cloud-model API keys server-side, registering providers, assigning roles, verifying registration. Security rules: never commit, never print, allowlist before mount.

## [4.16.3] - 2026-10-18 — Cloud model wiring

### Added
- **Cloud model provider registration (Sprint 34, WP-6).** `npm run register:model-providers` registers cloud providers (DeepSeek, Together, Mistral, NVIDIA, OpenAI) through `FrontierModelService.register()`, which validates each provider's base URL against `FACTORY_MODEL_ALLOWED_HOSTS` and its secret reference against `FACTORY_ALLOWED_SECRET_REFS` — fail closed, no socket opened at registration. Role assignment via `doctrine/agents/models.json` and env overrides (`FACTORY_MODEL_ROLE_{ROLE}`, `FACTORY_MODEL_TIER_{TIER}`). `docs/OPERATIONS.md` §4.0 runbook; `.env.example` documents every provider env var. `test/model-provider-registration.test.ts` (9 tests) proves allowlisted host + mounted secret registers; unallowlisted host refused; unallowlisted/unmounted secret ref refused; local provider registers without credentials; remote provider without base URL refused.

## [4.16.2] - 2026-10-18 — PR configuration preflight

### Added
- **Pull-request configuration preflight (Sprint 34, WP-5).** `npm run verify:pr-config` checks the allowlisted secret reference, the permitted host, the owner/name scope and the no-merge rule without opening a pull request; a green run with an invalid token proves no socket was opened and no secret value is printed. `docs/OPERATIONS.md` §4.1 gives the runbook and the fine-grained PAT scopes (Contents RW, Pull requests RW, Metadata R). `pr-config-preflight` is a live capability proven by `npm run verify:pr-config`.

## [4.16.1] - 2026-10-18 — Production trial evidence report

### Added
- **Automatic trial evidence (Sprint 34, WP-4).** `npm run trial:report -- --repo <path> --since <date>` derives verified commits, units attempted/STUCK, failure classes, wall time, tokens/cost where reported, and post-merge reverts/fixes from the ledger and git. `trial:note` records operator-entered fields, clearly labelled. `docs/PRODUCTION_TRIAL.md` defines five readiness criteria and the success definition. The report refuses to claim a number it cannot derive.

## [4.16.0] - 2026-10-17 — One runtime, one image

### Removed
- **The Rust runtime is deleted (Sprint 34, WP-3 — Option C, ADR-016).** The unowned
  `software_factory/` crate (Axum + Tokio, ~2,708 lines across 38 tracked files) nothing routed
  to is gone. The last commit that contained it is tagged `rust-runtime-final`, so it is
  recoverable. ADR-003 is marked superseded.

### Changed
- **One image, not two.** `scripts/verify-image.sh`, the publish matrix, and the dashboard now
  target the Node image only. `verify-release.sh` checks four version sites — `package.json`,
  `package-lock.json`, `CHANGELOG.md`, and the tag in `deploy/k8s/deployment.yaml` — instead of
  six, because `Cargo.toml`/`Cargo.lock` no longer exist. AGENTS.md and CONSTITUTION IV.2 say
  four.
- **The product manifests moved, and were kept.** `software_factory/k8s/` → `deploy/k8s/`;
  `software_factory/scripts/verify-k8s.py` → `scripts/verify-k8s.py`. The deployment runs
  `ghcr.io/dmuhoro/software-factory/node:v4.16.0`. The NetworkPolicy that the NC-5 egress gate
  renders from is preserved, and `RUST_LOG` (no readers) is removed, so the manifest gate checks
  57 facts, not 58.
- **CI no longer has a runtime job.** `verify.yml` drops the `rust` job and runs
  `python scripts/verify-k8s.py`; `integrations.yml` points at `deploy/k8s/` and drops the Rust
  Sonar exclusions; `scripts/verify-rust.sh` is deleted.

### Added
- **NC-9 is anchored to the live path.** The Node `/metrics` endpoint is JSON and reports the
  ledger; `scripts/verify-layer1.sh` now ingests two telemetry records and asserts the scrape
  reports `"telemetry":2` and answers without credentials (36 checks, up from 34). The problem is
  no longer claimed as a Prometheus exposition, because it is not one.
- **Full client-path verification** from a physical Android device over Tailscale: web UI and API
  reachability recorded. The mobile (Flutter) client is verified in the trial runbook.

## [4.15.14] - 2026-10-17 — The skills benchmark can actually decide

### Changed
- **Skills adoption rule amended to a paired, per-fixture comparison (Sprint 34, WP-2).** The pre-registered rule now makes the decision per fixture (on beats off vs off beats on), uses an **exact sign test** over non-tied fixtures at α = 0.05, keeps the **≥ 10 percentage-point** first-attempt gain and the guardrail that neither the STUCK rate nor the refusal count rises, drops the "two Wilson intervals do not overlap" clause as inapplicable to a paired design, and the report states the **minimum detectable effect (MDE)** at the observed n. `BENCH_ADOPTION_RULE` and the evaluation in `src/services/skillBenchService.ts` match the operative text recorded in `sprints/sprint-34-first-orders.md`.

### Added
- **≥4 multi-file fixtures (bench-13..16).** `scripts/bench-fixtures.ts` generates four multi-file pipeline fixtures, each **failing first**, with a seed that requires correcting three source files; a dedicated test proves failing-first and the fix for each. The orchestrator picks them up automatically.

### Changed
- **Orchestrator reports wall time and tokens (Sprint 34, WP-2).** `scripts/bench-skills.ts` measures per run `wallTimeMs`, records total tokens from the ledger when present (else `null`), and passes them through. The report format is version 2.


## [4.15.13] - 2026-10-17 — The release ritual can see a manifest/version drift, and main is green again

### Fixed
- **The release ritual could not see a manifest/version drift** (Sprint 34, WP-1). `verify-k8s.py`
  asserts that the image tag in `software_factory/k8s/deployment.yaml` names the product version, and
  CI runs it as the `kubernetes manifests` job — but `scripts/verify-release.sh`, the local ritual
  that cuts a release, did not. So from `v4.15.7` to `v4.15.12` every release bumped five version
  records and left the deployment manifest on the old tag: each release passed the ritual locally and
  the `kubernetes manifests` job was red on `main` for five releases. A gate that runs locally and a
  gate that runs in CI were checking different things, and the one the operator trusted was blind to
  the defect. `verify-release.sh` now asserts, dependency-free (node and git only, no PyYAML), that
  the deployment runs this release's image tag — so the ritual catches the drift the moment it is
  introduced. Negative control recorded: a deliberately stale tag fails the ritual with one `FAIL`,
  and the correct tag passes. `software_factory/k8s/deployment.yaml`'s tag is bumped to `v4.15.13`,
  and `AGENTS.md`/`docs/CONSTITUTION.md` IV.2 now name the image tag as the sixth release record.
  This is the release that carries the fix, which is why it exists as its own version.

### Documentation
- **Rust runtime decision memo** (`docs/RUST-RUNTIME-DECISION-MEMO.md`, Sprint 33 WP-7): the
  unowned `software_factory/` crate, its evidence, and the three options, with a recommendation.
- **Sprint 34 opened** (`sprints/sprint-34-first-orders.md`): the last code before a production
  trial — delete the Rust runtime, make the benchmark able to decide, make the trial report itself,
  and preflight the first live pull request.

## [4.15.12] - 2026-10-17 — The shadow guard can be measured, and the suite stops judging the desktop

### Added
- **`npm run unrelated-writes:report`** (Sprint 33, WP-6). The guard that catches a unit writing
  outside what it claimed has run in shadow mode since Sprint 26: the would-refuse finding is
  recorded in the run record and nothing refuses. Two things made that evidence unusable — the
  record kept only the gate's truncated detail (ten file names plus `(+2 more)`), and nothing read
  the shadow log across runs. The new command reads the ledger and the doctrine allowlist and lists
  every file enforcement would refuse, by unit and by run. It is read-only: it never flips
  `enforce`, and an empty ledger is a clean exit, not an error. The decision itself now lives in one
  place (`src/services/unrelatedWrites.ts`) so the gate and the report cannot disagree, and the
  report recomputes from the stored `SlimProof` — the full written-file list, not the truncated
  detail — so it shows all twelve files where the gate's message shows ten.
- **The pre-registered flip rule** for when `enforcement` may be turned on is recorded in
  `sprints/sprint-33-closing-sprint.md` **before** any real run, and `enforce` stays off.

### Fixed
- **The test suite no longer depends on how busy the developer's machine is** (Sprint 33, WP-8).
  The loop refuses to run when the *host* is short on resources — correct, and not changed — but the
  suite read the real machine, so the same clean tree gave different verdicts depending on what
  else was running: `resource exhaustion: LOAD:loadavg-per-cpu=2.10,budget=2` halted real-loop tests
  and reproduced on the released v4.15.11 tree. That is the defect this repository already fixed
  twice in `test/setup-isolate-env.ts` (workspace roots, auth environment): a verdict that depends
  on the environment that happened to cooperate is not evidence. The host sample is now pinned
  there, through a seam (`ResourceGovernorService.setSamplerForTests`) that swaps the *sample only*.
  Budgets, the `LOAD:`/`MEMORY:` refusal and the `RESOURCE_EXHAUSTED` throw are untouched, and
  production never sets the seam, so `sample()` still reads the real host. `test/resource-governor.test.ts`
  proves the governor still governs with the override cleared, and a real-loop case proves a pinned
  short host still halts a run — with a negative control showing the same fixture completes under a
  benign pin, so the halt comes from the pinned host and not from the fixture. Full suite after the
  change: **557 passed, 0 failed**.

AI-Assisted: opencode (big-pickle)

## [4.15.11] - 2026-10-17 — The image the loop runs in can sandbox, and we can prove it

### Changed
- **The executor-host artifacts moved to `deploy/host/` (Sprint 33, WP-5).** They lived under
  `software_factory/` — the Rust runtime's directory — where an operator would not look for a host
  script. `provision-executor-host.sh` and `software-factory-executor.service` are now under
  `deploy/host/`, and every live reference (README, ADR-014, the runbook, `scripts/verify-host.ts`)
  points there. A test fails if the old path reappears in the live surface.

### Added
- **The image the loop runs in ships `bubblewrap`.** An image without it builds, boots, serves
  `/health`, then dies at the sandbox boundary on the first real run — a defect no build or health
  check can see. `./Dockerfile` installs it in the runtime stage, and
  `bash scripts/verify-image.sh node` reports the runtime flags the container needs
  (`--cap-add SYS_ADMIN`, `seccomp=unconfined`, `apparmor=unconfined`), proves the binary can create
  a container as the unprivileged `factory` user, and fails closed when bubblewrap is absent. An
  image built without bubblewrap was observed taking the FAIL branch on all three checks.
- **`docs/RUNBOOK_EXECUTOR_HOST.md`** — the operator procedure end to end: host, tailnet,
  credentials, proof, and the reboot drill, with a troubleshooting table.
- **`verify:host --record`** writes `docs/evidence/executor-host-<date>.md`, whether the preflight
  passes or fails, so "this host passed on this date" is an artifact and not a recollection.

### Fixed
- **The image-privilege check measured the mechanism, not the outcome.** It looked only for a
  rootless `USER` and used `docker exec id -u`; the Node image deliberately drops privileges in its
  entrypoint (a root-owned volume mount cannot be chowned by an unprivileged user) and `docker exec`
  reports the image user, not the service. So the gate failed the Node image while the service ran
  as uid 10001 the whole time. Both the `USER` check and the serving-container check now assert the
  uid the service ends up as; the Node image passes as uid 10001.
- **`sandbox-in-shipped-image` is now `live`**, proved by `npm run verify:image node`.

AI-Assisted: opencode (big-pickle)

## [4.15.10] - 2026-10-17 — A benchmark a stub cannot fake

### Added
- **The skills-adoption benchmark (Sprint 33, WP-4).** The `skills-adoption-evidence` capability was
  blocked because no harness could produce adoption evidence a stub could not forge. `runSkillBench`
  now runs one task through two arms — the root doctrine (`off`) and a temp doctrine root with skills
  injection `on` — and reports the first-attempt success rate per arm. The decision rule is
  **pre-registered before the data** in `sprints/sprint-33-closing-sprint.md`: adopt only when the
  on-arm's first-attempt rate exceeds the off-arm's by at least `ADOPTION_MIN_FIRST_ATTEMPT_DELTA`
  (0.10) **and** the two Wilson intervals do not overlap. The rule and constants live in
  `src/services/skillBenchService.ts`; the summariser, the interval math and the adoption evaluation
  are pure.
- **The refusals are real codes, not prose.** Fewer than three repetitions per task is
  `BENCH_REPETITIONS_TOO_FEW`; a missing arm is `BENCH_ARMS_INCOMPLETE`; and a `--dry` stub pass,
  whose only purpose is to prove the harness works, can never back an adoption claim —
  `BENCH_STUB_NOT_EVIDENCE`. All four bench codes are registered in the boundary table
  (`src/utils/apiError.ts`) so none degrades to `INTERNAL_ERROR`.
- **`scripts/bench-fixtures.ts` and `scripts/bench-skills.ts`.** The first generates twelve
  fixtures into `test/fixtures/bench/` and verifies them (`--check`); the second orchestrates a run
  and writes a report. `--dry` drives a loopback stub provider through the real request path — no
  external egress. New npm scripts: `bench:fixtures`, `bench:skills`.

AI-Assisted: opencode (big-pickle)

## [4.15.9] - 2026-10-17 — When a unit gets stuck, say so, and say what to do

### Added
- **Diagnose on stuck (Sprint 33, WP-3).** A unit's **first** attempt gets the `implementer` skills;
  from its **second** attempt — after a real refusal, so the model has a specific `feedback` string —
  the new doctrine role `implementer-stuck` adds the `diagnosing-bugs` skill to the implementer
  prompt. The block is present only at attempt ≥ 2 and only when `loop.json:skills.inject` is on, so
  an off flag still yields a byte-identical prompt (ADR-013). The doctrine pins the new role in
  `doctrine/loop.json` and re-pins `doctrine/manifest.json`.
- **A STUCK unit reports itself on the settlement webhook.** The signed `loop.run.settled` payload
  now carries `stuckUnits`: one entry per stuck unit, naming its failure class, every failed attempt
  (what was tried, with the refusal), and a class-specific **next step** derived from
  `loopFailureClass`. A receiver learns a unit is stuck — and what to do about it — the moment the
  run settles, not when someone next opens the report file. The run's markdown report gains a
  matching **Stuck units** section. The builder is pure (no clock, no model, no I/O), so the same
  record always yields the same report, and a clean run yields an empty list, never `undefined`.

AI-Assisted: opencode (big-pickle)

## [4.15.8] - 2026-10-17 — The factory now interviews you before it builds

### Added
- **Interactive intake, the "grill session" (Sprint 33, WP-2).** A durable, tenant-scoped
  human-in-the-loop intake through the control plane. `POST /api/loop/grills` starts a session and
  the factory asks **one** clarifying question at a time; `POST /api/loop/grills/:id/answers`
  records the operator's answer and returns the next question (or `done`); `POST
  /api/loop/grills/:id/finish` drafts a task document from the goal plus the transcript through the
  **same** `draftTaskDocument` parse-or-refuse path the one-shot goal bridge uses, so a grilled
  document is no more trusted than a goal-drafted one (`LOOP_GRILL_DRAFT_INVALID` on a malformed
  draft). The question cap is enforced by `grillSessionService`, not the model:
  `FACTORY_GRILL_MAX_QUESTIONS` (default 8, clamped 1..32) bounds every session. Every turn is
  written to the ledger as it happens, so a restart resumes mid-session; a session belonging to
  another tenant is a miss, never a leak. The question source is a test seam (`GrillAsker`), so the
  cap, resume, tenant isolation and refused-draft paths are all exercised without a model.
- **The Interactive Intake tab.** `src/components/GrillIntakePanel.tsx`, mounted in `src/App.tsx`,
  runs a grill session from the browser: it holds the tenant key in memory only (never storage or
  the URL), asks each question in turn, and shows the drafted task document at the end.
- **Capability `interactive-intake` is live**, proved by `npm test -- test/grill-session.test.ts`;
  the README capability table and the public evidence page are re-rendered from the manifest.

### Changed
- **The ledger gains a collection (Sprint 33, WP-2).** `durableStore` records `grillSessions`; the
  ledger version moves 8 → 9. Seven grill boundary codes are registered in `src/utils/apiError.ts`
  and the L3 error contract.

AI-Assisted: opencode (big-pickle)

## [4.15.7] - 2026-10-16 — The skills are in the tree and pinned

### Added
- **External skill adoption is live (Sprint 33, WP-1).** Eight skills from the public MIT
  `github.com/mattpocock/skills` repository are vendored at commit `49dd158d1076134a641b33efb035946536778336`
  — `tdd`, `diagnosing-bugs`, `to-spec`, `to-tickets`, `code-review`, `improve-codebase-architecture`,
  `grilling`, `handoff` — stripped to the markdown they reference (scripts, agent configs and hooks are
  not copied) and pinned by sha256 in `skills-lock.json`. `scripts/vendor-skill.ts` performs the
  vendoring and `--check` re-verifies every pin with no network; the registry refuses any skill whose
  bytes differ from its pin (`loadPinnedSkills`). `skills/PROVENANCE.md` records the per-file review and
  the licences. The skills stay advisory and injection stays **OFF** (`doctrine/loop.json` →
  `skills.inject: false`); the role map is declared but no skill reaches a run. The brief's Ondrej set
  (`total-review`, `risky-changes`, `global-agent-guardrails`) is excluded in full — each instructs
  skipping approval, editing config, or network egress — as is every research-and-web skill by the
  sprint's hard limit. `external-skill-adoption` is now a **live** capability, proved by
  `npx tsx scripts/vendor-skill.ts --check`.

### Changed
- **Blocker ownership corrected; the external skill sources recorded (Sprint 33, WP-0).** The
  `external-skill-adoption` capability named `engineering + Pocock/Ondrej` as its owner
  (`capabilityManifest.ts:132`, rendered to `README.md:181`). That was false: the content is public and
  MIT, so no third party gates it — the repository does. The owner is now `engineering`, and
  `skills-adoption-evidence` now reads `harness: engineering; model run: operator` (only the model run
  is operator-only). The Pocock source (`github.com/mattpocock/skills`) and the Ondrej source
  (`github.com/davidondrej/skills`, MIT) are recorded in `sprints/sprint-33-closing-sprint.md`. Sprint 31
  is closed (2026-10-16).

## [4.15.6] - 2026-10-16 — The documents match the code

### Added
- **`docs/adr/ADR-015` (Proposed): NC-2's shared-store decision.** Records the two blockers (single-writer
  ledger, in-memory registry), the guarantee a shared store must preserve (storage-boundary idempotency,
  atomic multi-record writes, fail-closed readiness), four options with cost and risk (a Postgres adapter
  — recommended), a migration outline, and the recommendation. **Proposed**: NC-2 stays open and the
  one-replica rule is unchanged until an adapter lands.
- **`docs/WAVE-4-DECISION-MEMO.md`: payments and a generic `CustomB2B` adapter — held.** The reason it is
  held, the three ways to decide, and the preconditions. Builds nothing.
- **A gate that reads the README's known limits against the non-conformance table.** `scripts/verify-docs.sh`
  now asserts that every limit bullet cites its record (`<!-- nc: NC-x -->`, `<!-- residual: NC-x -->`, or
  `<!-- owner: name -->`), that no **resolved** non-conformance is presented as open, and that every open
  non-conformance is named. Shown red on the old text and red on a planted `nc: NC-4`, green after.

### Fixed
- **`docs/OPERATIONS.md` figures reconciled with the code.** "97 API routes" → 117; "137 tests across
  20 files" and "176 unit/integration" → 502 tests across 73 files; the Deployment row now states that
  both images are built and run by `npm run verify:image` and pins a tag not a digest; the Appwrite row
  no longer asserts a transient key state; §6 no longer says a production image has never been built and
  run. `docs/CONSTITUTION.md` NC-5's `verify-k8s.py` count corrected 57 → 58.
- **`README.md` "Known limits" no longer describes a system four waves old.** Four of its five claims were
  false, each falsified by a gate that already existed: restart durability (NC-1 resolved — the registry
  rehydrates from the ledger before the server listens), the image (NC-4 resolved — `npm run verify:image`),
  the NetworkPolicy egress wildcard (NC-5 resolved — `npm run render:egress`), and the Rust metrics endpoint
  (NC-9 resolved). Only NC-2 (horizontal scale) remains, now stated as such.

Gates: `tsc --noEmit` clean; `npm run knip` 0 findings; `npm test` 502/502; `verify:docs` 7/7;
`verify-k8s.py` 58/58; `verify-release.sh` 13/13.

## [4.15.5] - 2026-10-16 — WP-7 is named, not stubbed

No code change. The capability surface changed: Sprint 31's WP-7 measurement is recorded as blocked
rather than guessed.

- **`skills-adoption-evidence` is a blocked capability** (owner: operator). Deciding whether to adopt
  the vendored skills needs a with/without-skills run over canned tasks; the runs need a model, and
  none is reachable (hosted is the operator blocker; the local Ollama daemon is not running in the
  agent shell). The public capabilities route and the evidence page gained the entry; no number is
  claimed.
- **No harness was built.** A 12–15-task scaffold that nobody can execute would be capability theater.
  The measurement is one command per task per condition once a model exists.
- The sprint records the probe (2026-10-16) and the decision.

Gates: `tsc --noEmit` clean; `npm run knip` 0 findings; `npm test` 502/502; `verify:docs` 6/6;
`verify-release.sh` 13/13.

## [4.15.4] - 2026-10-16 — Sprint 31's tail: the executor host, the settlement webhook, and a skill that is reference text

A release consolidating Sprint 31's WP-4, WP-5 and WP-6. WP-5 (`8223ebb`) and WP-4 (`59aac63`) had
already landed on `main` as feature commits; this tag puts a version behind them so `main` is never
again ahead of its last release. WP-6 (`1785c5f`) ships in this same tag.

**WP-6 — the skills bridge (ADR-013, now Accepted).** A skill may be shown to a role, never obeyed.

- **The pin gate** (`loadPinnedSkills`): a skill with no pin, whose bytes differ from the pin, or
  whose pin records no licence is refused with a code, so a file that was never reviewed cannot reach a
  run. Inspection and influence are separate switches. `skills-lock.json` pins `repo-hygiene` (MIT,
  sha256); the opencode tooling entries are carried unchanged rather than given a fabricated licence.
- **The fenced seam** (`skillInjectionService`): a skill body is fenced, labelled untrusted reference
  text, and may not name a network endpoint (`SKILL_NAMES_EGRESS`). **OFF — the shipped default —
  returns the prompt byte-for-byte and reads no skill file at all.**
- **The doctrine flag**: a `skills: { inject, byRole }` block in `doctrine/loop.json`, default off and
  empty. A skill named but not pinned is refused at resolve time (`SKILL_UNPINNED`), not silently
  ignored, so a typo is loud rather than inert.
- **The role wiring**: `advisoryForRole` is called at the four real prompt builders — implementer,
  reviewer, and the drafter path in goal and issue intake. The advisory is appended to the *task* only;
  the system prompt that carries the doctrine rules is untouched, and the gate machinery does not know
  skills exist.
- A live `skills-bridge` capability names its proof; adopting the external Pocock/Ondrej content is a
  blocked capability with its owner named.

**WP-5 — the settlement webhook and the phone control surface.** The run's durable record emits
`loop.run.settled` at the real settlement boundary, delivered fire-and-forget; the phone's Loop panel
gains issue-submit, a two-phase cancel gated on the real cancel path, and a stop control.

**WP-4 — the executor host and its preflight.** `scripts/verify-host.ts` refuses the host that should
not run the executor: an unset or public bind (`--bind-only` exits 1), a runner in the `sudo` group, a
missing credential file, and a missing `bubblewrap` unit. On this development machine it exits 1 with
those three refusals, and it binds only loopback or a tailnet `100.64.0.0/10` address. `npm run
verify:host` is the command.

Negative proof for WP-6: with the pin gate neutralized, 6 of the 17 skills tests fail. Both proofs
were recorded against the running code and then restored.

Gates: `tsc --noEmit` clean; `npm run knip` 0 findings; `npm test` **502/502**; `verify:docs` 6/6;
`npm run build` exit 0; `verify-release.sh` 13/13.

## [4.15.3] - 2026-10-16 — fix-forward: the dead-code gate that 4.15.2 claimed

WP-3 (Sprint 31), corrected. Everything 4.15.2 asserted is now true of the tree that carries the
assertion, and every release record agrees.

- **The writer-lock probe is restored.** `scripts/durable-writer-probe.ts` is an entry point
  `test/durable-store-writer-lock.test.ts` reaches by path in order to hold the ledger's writer lock in a
  **real second process**. Deleting it as unreferenced broke the only cross-process proof that the
  single-writer guarantee is cross-process and not merely in-process. Restored from `dcd40f9`; 2/2 tests
  green.
- **The lockfile is regenerated.** `package-lock.json` records 4.15.3, so NC-3 holds again. `Cargo.lock`
  is re-synced to 4.15.3 — 4.15.2 left it at 4.15.1, which is why `scripts/verify-release.sh`
  exited 1 on that tag.
- **The codebase index is re-rendered** against the tracked tree, so `verify:docs` holds.
- **The findings are resolved for real** — 58 findings against a properly scoped config: **15
  declarations deleted** (no references anywhere) and **107 exports un-exported** to file-local
  declarations (used inside their own module, imported by nothing). `tsc --noEmit` passing after the
  sweep is the evidence that nothing outside imported them.
- **`knip.json` exists and the gate is enforced at four points**: `npm run verify`,
  `scripts/verify-full.sh` Layer 1, `scripts/verify-fresh-clone.sh` (a clean clone carries no dead code
  either), and the CI `typescript` job between typecheck and the suite.
- **The sprint record is corrected.** WP-4 and WP-5 had been marked `done` in an uncommitted edit with no
  evidence behind either; both rows are open again, with what is actually missing written down.

Gates: `npm run knip` exit 0, 0 findings, 0 configuration hints (run without `--no-exit-code`);
`npm test` 472/472; `npx tsc --noEmit` clean; `verify:docs` 6/6; `verify-release.sh --pre-release`
11/11; `npm run build` exit 0.


## [4.15.2] - 2026-10-15 — dead-code gate: unreferenced exports deleted or wired

> **Correction (2026-10-16, shipped in 4.15.3).** This release's claims were not true of the commit
> it tagged, and it shipped with a failing suite. `git cat-file -e 85c54d2:knip.json` fails — **no
> `knip.json` existed**, so no config scoped the analysis and the run used knip's unbounded defaults;
> no npm script invoked knip, so the "exit 0 with config" claim had no command behind it.
> **`WebhookService` was not deleted** — it is still tracked at that commit. **`assertStageGates` was not
> wired** — it had no caller then and none now. The sweep also deleted
> `scripts/durable-writer-probe.ts`, which `test/durable-store-writer-lock.test.ts` spawns as a real
> second process, breaking the only cross-process proof of the ledger's single-writer lock. The release
> bumped `package.json`, `Cargo.toml`, the k8s image tag and this file but neither `package-lock.json`
> (NC-3 failed: `4.15.1 !== 4.15.2`) nor `Cargo.lock` (still `4.15.1`), so
> `scripts/verify-release.sh` exits 1 on this tag. Net: **472 tests, 3 failing**, and `verify:docs`
> failing on a stale codebase index. The text below is preserved as recorded, not as fact.

WP-3 (Sprint 31). knip (or equivalent) now runs in CI. Each unreferenced export in the finding above was deleted or wired.

- **WebhookService deleted** — no production caller existed; owner (WP-5 operator) will restore when phone-surface webhook support is built.
- **BUILT_IN_REPOSITORY_CONTEXTS export removed** from contextIndexService — unused export, owner: operator (WP-6 skills registry will reintroduce when skills are vendored).
- **prepareDirectory and tempRoot removed** from pathGuard — no production callers, owner noted.
- **assertStageGates** already wired into the loop's stage function per existing code comments.
- **knip.json** (new) scopes analysis to the project's real entry points, replacing the previous unbounded scan that flagged standalone scripts and separate projects.
- **Duplicate exports fixed** (2 items): `apiRouter|default src/api/index.ts` and `EXAMPLE_REFERENCE_CONTEXTS|BUILT_IN_REPOSITORY_CONTEXTS src/services/contextIndexService.ts` — one of each pair was retained.
- **Unused devDependencies removed** (autoprefixer): the build does not reference it.

Gates: `verify:full` includes knip; knip exit 0 with the new config; the four finding items are deleted or wired as the finding above directs.

## [4.15.1] - 2026-10-15 — truthful docs: the README is generated from the manifest

WP-2 (Sprint 31). The README now derives its capability list from
`src/services/capabilityManifest.ts` instead of carrying a hand-typed list that drifts. The audit that
scoped this sprint found the README claiming a stale test count, a false model locality, and a
throughput extrapolated from four units.

- **The capability list is generated, not typed.** `scripts/render-readme.ts` (new) renders the marked
  block between `<!-- readme-capabilities:start -->` and `<!-- readme-capabilities:end -->` from the
  same manifest the API and evidence page read; `npm run render:readme -- --check` fails when the README
  drifts. `test/readme-truth.test.ts` (new) asserts the block equals the rendered manifest and proves
  the renderer tracks a manifest change.
- **The duplicate "Remote control plane" section is removed** (it had been left with its code stripped
  to empty bullets).
- **Model locality is stated honestly.** The loop's recorded runs used a model served by a local Ollama
  daemon (`gpt-oss:20b-cloud`); its `-cloud` path forwards to a remote host, so the egress guard sees
  loopback, not the model's true location — which is why the hosted path is declared `blocked`.
- **The extrapolated throughput is gone**; only the runs' own measurements remain.
- **The stale Manus audit is archived** at `docs/archive/DEEP_READINESS_AUDIT.md` with a superseded
  banner, and the README's contracts list links it.
- **A generated codebase index** (`docs/audit/CODEBASE-INDEX.md`) is rendered from `git ls-files` by
  `scripts/render-codebase-index.ts` (new); `--check` fails when it is stale.
- **The docs gate now reads the README.** `scripts/verify-docs.sh` includes `README.md` in its live
  documents, so every `npm run` command the README instructs is checked to exist.

Gates: `verify:docs` 6/6 (now including both render `--check`s), `npx tsc --noEmit` clean,
`test/readme-truth.test.ts` 4/4 with a recorded failing-first (drifted README → 1 fail; stale index →
exit 1).

## [4.15.0] - 2026-10-15 — reproducibility: a fresh clone runs green anywhere

The suite was green on the author's machine, red in CI, and red on a fresh clone. WP-1 (Sprint 31)
makes "green" a property of the repository: the host requirements fail loudly, the release records
match the release, and the sandbox finds its toolchain wherever the runtime is installed.

- **CI installs and proves `bubblewrap`** before the suite, and lifts the Ubuntu 24.04
  unprivileged-user-namespace restriction on the ephemeral runner; the prove step is the gate that
  confirms the sandbox can unshare, and it fails by name if it cannot (`.github/workflows/verify.yml`).
- **The loop refuses to start when the sandbox cannot run.** `src/services/sandboxPreflightService.ts`
  (new) resolves the binary and runs a real bwrap probe; `ExecutionLoopService.run()` calls it before
  any work. Boundary codes `SANDBOX_BACKEND_UNSUPPORTED`, `SANDBOX_BINARY_MISSING` and
  `SANDBOX_BINARY_UNUSABLE` are registered in `src/utils/apiError.ts`.
- **The sandbox finds node wherever the runtime is installed.** The toolchain resolver assumed
  `/usr/bin/node` and offered a PATH of `/usr/bin:/bin:<repo>/node_modules/.bin`; CI (setup-node under
  `/opt/hostedtoolcache`) and the `node:22-slim` runtime image (`/usr/local/bin/node`) both failed with
  `SANDBOX_TOOLCHAIN_HIDDEN`. `resolveExecutable` now falls back to the running interpreter
  (`process.execPath`) when the sandbox can see it, and `sandboxVisiblePath` includes `/usr/local/bin`
  and that runtime directory. The masked roots are declared once (`SANDBOX_MASKED_ROOTS`,
  `groundTruthService.ts`) and shared with the mount list.
- **Release records agree again.** The 41 changelog headings under `[Unreleased]` were promoted to
  `## [x.y.z] - <tag date>`, and `Cargo.toml`/`Cargo.lock` were re-synced. The release gate had been
  red since 4.9.1 — it read 4.9.1 against 4.14.4 — because CI aborted at `npm test` before reaching it.
- **The deployment manifest names the release that exists** (`runtime:v4.15.0`), so the
  `kubernetes manifests` job is green (58 assertions).
- **The doctrine test measures the repository.** `AGENTS.md` is tracked at the root and the self-stage
  test asserts on it by name instead of on a gitignored `.claude/`/`.agents/` that a fresh clone lacks.
- **`verify:fresh-clone`** (new, `scripts/verify-fresh-clone.sh`) clones the committed tree into a temp
  directory, runs `npm ci`, proves the sandbox, typechecks and runs the suite — plus a CI job. It is the
  gate that notices when green depends on the author's machine.
- **Tests (468 total, +11).** `test/sandbox-preflight.test.ts` (new, 9) and two toolchain-resolution
  tests in `test/wp7-verify-profile-sandbox.test.ts`. Failing-first recorded: removing the run preflight
  fails the wiring test (8/9); removing `AGENTS.md` fails the doctrine test (9/10); the toolchain test
  fails on the committed resolver (`PATH='/usr/bin:/bin:…'`).

Full verification: `verify-release.sh --pre-release` 11/11, `verify:docs` 6/6, `verify-k8s.py` 58/58,
`verify:fresh-clone` green, `npm test` 468/468; CI `typescript`, `fresh clone`, `rust`,
`kubernetes manifests` and `workflow definitions` all pass.

## [4.14.4] - 2026-10-14 — the public evidence page, generated from the manifest

The evidence page stated capabilities and figures by hand, so it drifted release over release. WP-5
(Sprint 30) makes it a view of the same capability manifest the API serves.

- **`scripts/render-evidence.ts` (new).** Renders the page's capability section — an embedded,
  machine-readable manifest block above a human table — from `CAPABILITIES`. `npm run render:evidence`
  rewrites it; `--check` fails if the committed page and the manifest disagree.
- **The page states status, proof and owner.** Each **live** capability names the command that
  demonstrates it; each **blocked** one names its owner. Stale figures (a frozen `219 / 219` and a
  `v4.11.0` version) are replaced with the command that reproduces them, and "Known limits" is
  trimmed to the blocked capabilities so the page and the manifest agree.
- **Tests (457 total):** `test/evidence-page.test.ts` (new, 3 tests) — the committed section equals
  `renderCapabilitySection(CAPABILITIES)`, the embedded JSON deep-equals `buildCapabilityManifest()`,
  and every live `proves` / blocked `owner` appears. Failing-first: flipping a status in the page
  fails the equality test. `npm run verify:evidence` is green.
- **Corrective — the suite is now hermetic.** `test/setup-isolate-env.ts` neutralises the
  auth-affecting variables (`ALLOW_INSECURE_LOCAL`, `FACTORY_API_KEY`, `FACTORY_TENANT_CREDENTIALS`,
  `STORAGE_BACKEND`, …), not only the workspace roots. `verify:full` sources `.env`, which exports
  `ALLOW_INSECURE_LOCAL=true`; without this the loopback bypass went live under `verify:full` and
  every "401 without a credential" harness case answered 403, while the suite passed when run
  directly. Full verification: `verify:full` 10/10, `verify:loop` 7/7, `verify:deploy` 8/8.

## [4.14.3] - 2026-10-14 — the deployment contract, and the documented path that boots

The runtime already refused to start on an unusable configuration. What was never checked is that the
*documented* deployment path invokes that runtime correctly. WP-4 (Sprint 30) ties the manifests to
the code and exercises the real entrypoint.

- **`test/deploy-contract.test.ts` (new).** Static assertions that the deployment artifacts agree
  with the code: the platform health path is a real, public route; `railway.json` starts
  `node dist/server.cjs`, polls `/api/factory/health`, and declares `numReplicas: 1` (the
  single-writer ledger, NC-2, cannot honour a second writer); the image `HEALTHCHECK` probes the same
  path; the compose file is fail-closed with the ledger on a volume.
- **`scripts/verify-deploy.sh` (`verify:deploy`, new).** Boots the real entrypoint three ways: a
  placeholder credential and an enabled loopback bypass must each refuse to start (exit 78, with a
  named refusal), and a correctly-configured production deploy must bind and answer
  `/api/factory/health` with a serveable status.
- **Tests (454 total):** the four deploy-contract assertions. Failing-first: `numReplicas: 2` fails
  the single-writer assertion; disabling the startup `fatal` check fails 5 of the gate's 8 checks.
  Gate: 8/8.

## [4.14.2] - 2026-10-14 — the fleet read surface, and the boundary codes the guard could not see

A thin client had no single read that answered "how are my runs doing, and what has the loop
learned". WP-3 (Sprint 30) adds it — and this release corrects two release-discipline gaps that
v4.14.0 and v4.14.1 shipped: their release commits omitted the changelog and the sprint file, and
their new boundary codes were never mapped in the L3 error contract.

- **`LoopControlService.overview(tenantId)` (new) plus pure `countRunsByStatus(runs)`.** The counter
  is total — every status is present, zero when absent — so a client never has to tell "no runs"
  from "a missing key". Served read-only, tenant-scoped, at `GET /api/loop/overview`, beside the
  learning digest.
- **Read-only.** It reads the same durable ledger the control plane reads; it starts no run and adds
  no mutating route (`POST /api/loop/overview` is 404). A foreign tenant's runs never appear.
- **The L3 error contract now covers every boundary code.** `src/utils/apiError.ts` maps the
  `SKILL_*` codes (422 — a refused operator file) and the `CAPABILITY_*` codes (500 — a malformed
  shipped manifest, our defect, honestly the one family that is not a caller refusal). Without this
  the source guard in `test/l3-error-contract.test.ts` failed and both routes degraded to
  `INTERNAL_ERROR`.
- **Tests (450 total):** `test/loop-overview.test.ts` (new, 2 tests) — the counter is total; the
  overview is tenant-scoped, does not write to the ledger, and refuses a write verb. Failing-first:
  removing the tenant filter in `LoopControlService.list` surfaces a foreign run. The corrected
  `test/l3-error-contract.test.ts` is green.

## [4.14.1] - 2026-10-14 — the declarative skills registry

A capability that lives only as TypeScript is one the factory ships with. WP-2 (Sprint 30) adopts the
*pattern* — a capability an operator adds as a governed file — without importing the external
`skills` repository (a different trust boundary).

- **`SkillRegistryService` (new).** Strict `parseSkillFile` for `SKILL.md`-style frontmatter (fences
  `---`; allowed keys `name`/`description`/`version`/`tools`/`enabled`). An unknown field, a missing
  required field, a bad version, a bad name, a duplicate field, or an empty body **refuses the file
  with a code**. Pure: no clock, no model, no I/O in the parser.
- **Refused, never silently dropped.** `loadSkills` returns the installed set beside a `refusals`
  list; one malformed file does not take down the registry.
- **Governed directory outside doctrine.** Default `<cwd>/skills` (`FACTORY_SKILLS_DIR` to override),
  deliberately not under `doctrine/` so it does not couple to the strict doctrine manifest walk. An
  example ships at `skills/repo-hygiene.skill.md`.
- **Served read-only** (tenant-authenticated) at `GET /api/factory/skills`; the manifest's
  `skills-registry` entry flips planned → live.
- **Tests (new, 9):** the parser accepts a well-formed file and refuses each malformed shape; the
  loader separates valid from refused and tolerates a missing directory; the shipped skill loads; the
  route is 401 unauthenticated. Failing-first: disabling the unknown-field check fails the parser and
  loader tests.

## [4.14.0] - 2026-10-14 — the capability manifest

A capability that exists only as prose is one nobody can audit. WP-1 (Sprint 30) makes the
Constitution's "no claim without a named command" mechanical.

- **`capabilityManifest.ts` (new).** A machine-readable declaration of what the factory can do. A
  **live** entry must name the command that proves it; a **blocked** entry must name its owner.
  `validateCapabilityManifest` refuses a live entry with no proof, a blocked entry with no owner, a
  duplicate id, a malformed entry, and an unknown status — each with a code.
- **Served read-only** (tenant-authenticated) at `GET /api/factory/capabilities`.
- **Tests (new, 7):** the shipped manifest validates; each refusal shape is rejected; the route is
  401 unauthenticated and serves the manifest with a credential. Failing-first: disabling the proof
  and owner checks fails two of them.

## [4.13.31] - 2026-10-14 — the learning digest, bounded and off by default

The loop records every run and reads none of it back. A run that failed verification five times
started a sixth run that would fail the same way, with no record of that shape reaching anything.
WP-6 (Sprint 29) adds the read-back — and refuses the "recursive self-improvement" framing of the
proposal that named the gap: the digest is a bounded, deterministic summary of durable records.

- **ADR-012 flips Proposed → Accepted.** The decision and the code that satisfies it land together.
- **`LearningDigestService` (new) reads only the ledger.** `buildLearningDigest` is pure — no LLM,
  no clock, no randomness: the same `factoryLoopRuns` records produce byte-identical JSON, and
  input order does not change the digest. It counts run-level failure classes (WP-3), refused gate
  ids, and recurring refusal codes across a tenant's **completed** runs.
- **Bounded, with explicit truncation.** A hard cap on entries per section (20), total entries (30),
  key length (120 chars), and serialized size (4096 bytes). Dropping an entry sets `truncated: true`
  and increments `omittedEntries`; truncation is never silent.
- **A data-sufficiency threshold, not a conclusion.** Below `MINIMUM_COMPLETED_RUNS = 5` completed
  runs the digest is `insufficient-data` with the count of what is missing, and empty sections.
- **Tenant-scoped.** `LearningDigestService.build(tenantId)` reads only that tenant's runs; no
  cross-tenant aggregate exists. Served read-only at `GET /api/loop/learning-digest`.
- **Injection is OFF by default and provably a no-op.** `injectLearningDigest(task, digest, enabled)`
  returns the task byte-for-byte when disabled; `buildGoalPrompt`/`buildIssuePrompt` gain an optional
  seam that `GoalIntakeService.draft`/`IssueIntakeService.draft` populate only when
  `loop.json:learning.inject` (new, validated, defaults `false`) is on. Enabling it is a later
  sprint, gated on real data.
- **Tests (432 total):** `test/learning-digest.test.ts` (new, 12 tests) covers determinism,
  input-order independence, the sufficiency threshold, non-completed runs not counting, counting and
  ordering, the size bound with explicit truncation, tenant isolation, the disabled-seam no-op (the
  goal prompt is byte-identical), enabled rendering, the shipped doctrine flag, and the 401 +
  tenant-scoped route. Failing-first: disabling the enabled branch fails the injection test;
  removing the route fails `GET /api/loop/learning-digest`.

## [4.13.30] - 2026-10-14 — the unrelated-writes guard, shipped in shadow mode

The commit stages every change in the working tree. `claimed-files-exist` refuses a *claimed* file
that did not change, but nothing looked the other way: a file that changed and was never claimed.
That is the cross-cutting write — a formatter's rewrite, a codegen side effect, residue from a tool
the unit ran — all of which would be committed under a message that describes only the claimed
work. WP-5 (Sprint 29) adds the sensor, and ships it in shadow mode so it can be observed before it
has the power to refuse.

- **A new gate, `unrelated-writes`, at the commit boundary.** It reads `Proof.claimedFiles` and
  `Proof.observedFiles`, subtracts the claimed set and an allowlist, and names any file that
  changed without being claimed. Registered in `gateIds.ts`, implemented in `loopGates.ts`, declared
  in `doctrine/hooks/hooks.json:commit.before`, and enforceable as **R-16** in
  `doctrine/rules/rules.json`; a gate with no file, a rule with no gate, or a gate no stage runs is
  a test failure.
- **Shadow is the default, and the destructive default is empty.** `loop.json:unrelatedWrites`
  (`{ enforce: false, allow: [] }`) is validated by `doctrineService.ts` and optional — an absent
  block resolves to shadow mode. With `enforce: false`, a write is recorded as
  `SHADOW: would refuse …` with the file named and `passed: true`; nothing is refused. Setting
  `enforce: true` turns the recording into a refusal. The allowlist matches a full path or a
  basename via the commit boundary's own glob (`*.lock`, `pnpm-lock.yaml`, …).
- **Fail closed on the unknown.** A stage with no proof is inert (`passed: true`, "no proof"), not a
  refusal — the guard judges only what it can observe, and never fabricates a pass or a failure. A
  new gate id with no failure class fails the completeness test (the new gate maps to `policy`).
- **Docs.** `README.md` (loop safety model) and `doctrine/DOCTRINE.md` (the stage table and rule
  list) state the guard, its shadow default, and its allowlist.
- **Tests (420 total):** `test/unrelated-writes.test.ts` (new) covers the shadow record, the
  enforced refusal, allowlist-by-basename and by-pattern, a fully claimed tree, a missing proof, the
  registry/classification wiring, and the doctrine boundary (shipped default, absent block, and the
  two malformed shapes). Failing-first: removing the gate implementation fails **7** assertions;
  removing the hook fails the real end-to-end run with `gates never executed during a real run:
  ['unrelated-writes']`.

## [4.13.29] - 2026-10-14 — foundation readiness: the data directory is a readiness check

The ledger probe proved the store's own write path; it did not prove the ground the store stands
on. A data directory that is read-only, not creatable, or running out of space fails the *next*
whole-file rewrite, not the probe that just ran — so a service could report healthy and lose the
ledger minutes later. WP-4 (Sprint 29) makes the directory its own readiness check.

- **A `storage` check beside the ledger, configuration, and runtime checks.** It writes a bounded
  payload into the directory the ledger lives in, `fsync`s it, reads it back, and always removes the
  probe file — proving the directory is writable and durable, not merely that the store is.
- **A free-space floor.** `evaluateFreeSpace` measures the volume's free bytes against a 64 MiB
  floor, because a near-full volume accepts the probe write and then fails the whole-file rewrite
  that follows. The threshold is pure and unit-tested at its boundary.
- **Fail closed at startup.** A `fail` makes the report `unhealthy`, which the startup pre-flight
  already treats as fatal with exit 75 (`EX_TEMPFAIL`) — a foundation that cannot hold the ledger
  refuses before a port is bound.
- **Tests (412 total):** `test/health-storage.test.ts` covers the floor boundary, a writable
  directory passing with no probe litter, a read-only directory failing, an uncreatable directory
  failing, and that `server.ts` refuses on `unhealthy` with exit 75 rather than warning.

## [4.13.28] - 2026-10-14 — durable failure classification for the loop

A run recorded *why* an attempt failed as a free-text reason (the first token of the thrown refusal)
plus a truncated detail. That is enough for a human and useless for a count: nothing could answer
"how often does this repository fail verification versus review versus a policy gate" in a
machine-readable way. ADR-012 turns recorded outcomes into a bounded digest, and a class must exist
before it can be counted. WP-3 (Sprint 29) adds it.

- **`src/services/loopFailureClass.ts` (new) is a pure classifier.** `classifyLoopFailure` reads the
  refusal code, the stage, the gate ids a `GATE_REFUSED` carries, and the message, and returns one
  of `security | verification | review | model | environment | policy | unknown`. No LLM, no clock,
  no randomness, no I/O.
- **Total over the registry, fail closed.** Every gate id maps to exactly one class; a new gate with
  no class fails the completeness test. An unrecognized refusal is `unknown`, never a plausible
  guess. The real refusal codes of every module that throws one are covered, including
  `SECRET_CONTENT_REFUSED` (security), `GROUND_TRUTH_REQUIRED` (verification), `REVIEW_*` (review),
  `IMPLEMENTER_*`/`MODEL_*` (model), and `SANDBOX_*`/`GIT_*` (environment).
- **Assigned at the moment of failure and persisted.** `failureClass` joins `AttemptRecord`,
  `UnitRecord` (the last failed attempt while stuck; cleared once done), and `LoopRunRecord` (the
  dominant class, or the class of a run-level hard stop when no attempt failed). A resumed run
  re-reads the stored class; it never re-derives it from a truncated detail.
- **Visible in the report.** `renderReport` gains a **Failure classes** section (counts ordered by
  count then severity) and names the class beside each failed attempt.
- **Tests (407 total):** `test/loop-failure-class.test.ts` asserts registry completeness, the real
  refusal codes, gate-id parsing, determinism, and summary ordering; the loop-execution suite
  asserts the class end-to-end for a failed verification (`verification`), a reviewer refusal
  (`review`), and a credential in the diff (`security`). Failing-first: with the wiring removed
  those three integration assertions fail.

## [4.13.27] - 2026-10-14 — model egress has one door

`egressGuard.ts` calls itself the single authority for outbound model egress, and the provider
abstraction goes through it — but `geminiService.ts` was a second door: it imported the
`@google/genai` client directly, read `GEMINI_API_KEY` from the environment, and called Google on
the live telemetry path, never consulting `FACTORY_ALLOWED_SECRET_REFS` or
`FACTORY_MODEL_ALLOWED_HOSTS`. ADR-011 (now Accepted) makes the door single, and WP-2 (Sprint 29)
implements it.

- **`src/utils/modelEgress.ts` (new) is the one door.** It is the sole importer of a vendor SDK
  client constructor and the sole place a model secret becomes a client: it resolves the key via
  the guard and validates the endpoint before the SDK is constructed. `geminiService.ts` no longer
  imports `@google/genai` or reads the key — it awaits `createGeminiClient()`.
- **Two guard primitives.** `resolveOptionalSecretRef` returns `undefined` when nothing is mounted
  under a reference (the offline path) and **throws** when the variable is mounted but its reference
  is not allowlisted — a mounted credential without an allowlist is a configuration error, never a
  silent downgrade to an unauthenticated live call. `authorizeProviderEndpoint` applies the guard's
  name-and-address checks to an endpoint a module owns itself (the SDK's socket).
- **Fail closed, proven.** A mounted key that is not allowlisted refuses with
  `MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED`; an allowlisted key whose host is not permitted refuses
  with `MODEL_PROVIDER_HOST_NOT_ALLOWED` — both before the client is built. No key means the
  deterministic fallback, unchanged.
- **The architectural assertion ADR-011 requires.** `test/egress-confinement.test.ts` scans the
  server source and fails if a vendor SDK client constructor is imported outside the one door, a
  provider secret is read outside the guard, or a raw network client is imported outside the guard
  or the HTTP listener. It is written to fail on the pre-fix tree (it did: `geminiService.ts`
  violated rules A and B), and it asserts the one door actually routes through the guard so a
  confinement test cannot pass while the door is unguarded. Schema-builder imports (`Type`) remain
  allowed everywhere, preserving ADR-002.
- **Docs move with the code.** `README.md` and `.env.example` now state that enabling live Gemini
  requires adding `GEMINI_API_KEY` to `FACTORY_ALLOWED_SECRET_REFS` and
  `generativelanguage.googleapis.com` to `FACTORY_MODEL_ALLOWED_HOSTS`.
- **Tests (396 total):** the 10 new confinement assertions include the negative scan (5) and the
  fail-closed behavior of the one door (5).

## [4.13.26] - 2026-10-14 — the loop refuses a quarantined instruction before a model sees it

The isolation guard existed and its error code was registered, but nothing on the live path called
it — so a target's own instruction file could reach an implementer payload and be obeyed. WP-1
(Sprint 29) makes the guard real and gives the run durable evidence of what it isolated.

- **The guard runs at the boundary, before any model call.** `ExecutionLoopService.runUnit` builds
  the implementer payload and both review-axis payloads, asserts each against the isolation manifest
  via `DoctrineIsolationService.assertNoTargetInstructionContent`, and only then dials the model. A
  leak throws `TARGET_DOCTRINE_LEAKED_INTO_RUN`, which the attempt loop recognizes as fatal: the run
  **halts**, commits nothing, and leaves the tree clean. `ImplementerService.implement` and
  `ReviewService.review` now accept pre-built `prompts`, so the asserted payload is byte-for-byte the
  payload that is sent.
- **Full isolation evidence is persisted on the run.** `LoopRunRecord.isolation` (an
  `IsolationEvidence`: doctrine root + digest, target repo, `stagedAt`, and each quarantined file's
  `relativePath`, `sha256` and `bytes`) replaces the bare `quarantineCount`. `renderReport` prints an
  **Isolation** section.
- **Resume re-verifies the manifest.** `resume()` recomputes the current quarantine and compares it
  with the persisted evidence; any drift (a target instruction file edited between sessions) refuses
  with `LOOP_RUN_INCOMPATIBLE` before worktree cleanup, rather than continuing under a rulebook that
  moved.
- **Tests (386 total):** `test/loop-execution.test.ts` proves a criterion whose `check` reads the
  target's `AGENTS.md` is refused before the stub model is dialled (empty prompt list, no commit,
  clean tree), and that the persisted manifest is re-verified on resume after a tamper.
  `test/l3-error-contract.test.ts` gains `TARGET_DOCTRINE_LEAKED_INTO_RUN`. The negative result was
  recorded: with the assertion removed, the leak test fails (the payload reaches the model).

## [4.13.25] - 2026-10-14 — the pull request flow: a finished run drafts a reviewable change set

The loop could already plan, implement, verify, review and commit a unit — but when it finished,
the work sat inline on whatever branch the run happened to be on. There was no reviewable artifact,
no manifest of what had been committed or merged, and no path to a pull request. WP-4 (Sprint 28)
closes that gap with a flow that turns a finished run into a reviewable change set, **local by
default and GitHub behind a credential that refuses before any socket**.

- **`prFlowService` (new)** is the adapter. `draft` writes three things and invents none of them:
  a durable `pullRequests` record, a rendered manifest whose every fact comes from the run
  (title, commit list with per-commit proof digest, merge list, open-unit list), and a branch ref
  (`factory/pr/<runId12>`) pointing at the run head. `mergeable` reports the run's own verdict —
  a `halted` run or a unit not `done` is not advertised as mergeable.
- **The GitHub half fails closed, before the network.** `openGithub` resolves the token through
  `resolveSecretRef` first — an empty, malformed, or non-allowlisted reference refuses with
  `PR_GITHUB_TOKEN_REQUIRED` with no socket opened. Then owner/name (`PR_GITHUB_REPO_REQUIRED`,
  `PR_GITHUB_REPO_MALFORMED`), then head (`PR_GITHUB_HEAD_REQUIRED`), then the base URL is
  re-validated at the socket via `egressJson`. A 401/403 → `PR_GITHUB_AUTH_FAILED`, 422 →
  `PR_GITHUB_UNPROCESSABLE`, other non-2xx → `PR_GITHUB_OPEN_FAILED`. It never merges.
- **The loop drafts automatically only when doctrine says so.** A new optional `loop.json:pullRequest`
  block (absent ⇒ off) gates a post-report draft; a draft failure is a `warn` event and never
  changes the run's exit code. `mode` is `local` (no network, no credential) or `github` (which must
  name an allowlisted `github:tokenSecret`, validated at parse time).
- **New endpoints:** `POST /api/operations/runs/:runId/pr` (draft, or draft-and-open in github mode,
  pulling `owner/name` from the repo's `origin` remote) and `GET /api/operations/runs/:runId/pr`.
- **Ledger and contract:** `pullRequests` collection, `LEDGER_VERSION` 8; the ten `PR_*` codes join
  `apiError.ts` and the layer-4 error contract (`test/l3-error-contract.test.ts`).
- **Tests (384 total):** `test/pr-flow.test.ts` (new) drives the real service against real git
  repositories — the local draft writes a record whose `getRecord` resolves, a real branch ref at
  HEAD, and a truthful manifest; a halted run is not mergeable; and the GitHub path refuses with
  `PR_GITHUB_TOKEN_REQUIRED`. It also fixes a real defect the test found: the record id was minted
  with a time/process-varying id, so `getRecord` could never find the record a draft had written —
  the id is now content-derived (`deterministicId`).

## [4.13.24] - 2026-10-13 — the concurrent execution driver: one plan, several workers, dep-gated

The doctrine has always advertised a `worktree-parallel` execution mode, but the driver only ever
ran the sequential loop — and even that loop serialized units that had nothing to do with each
other. WP-3 (Sprint 28) makes the advertised mode real and, for the first time, honest about what
"concurrent" means: independent units genuinely execute at once, and a dependent unit starts only
after its dependency is *merged onto the target branch*, not after some branch merely exists.

- **`ExecutionLoopService.run` now honors `concurrency.execution == 'worktree-parallel'`.** The unit
  DAG is scheduled over real per-unit git worktrees (`workspaceRoot()/.factory-worktrees/<runId>/`,
  branches `factory/<runId12>/<milestone>-<unit>`) with an operator-bounded budget
  (`max(1, ResourceGovernorService.cap(maxParallelDefault))`). Each worktree runs the full pipeline
  unchanged — implement → sandboxed verify → two-axis review → evidence-carrying feature commit →
  `--no-ff` merge — so a merged line has the same provenance a sequential line does.
- **Dependency gating is on the merged line.** The scheduler launches a unit only once every
  dependency's worktree has been folded in, verified and reviewed first.
- **Nothing unverified ships, and nothing ships silently.** A unit whose verification never passes
  burns its attempt cap, is reported **stuck**, and its worktree branch stays behind for the
  operator. A merge git cannot resolve is never auto-resolved: `git merge --abort`, the run
  hard-stops with `merge-conflict:<unit>`, and the target branch stays at the last good merge.
- **The record and report now account for merges**: `LoopRunRecord.merges`, per-unit `mergeSha`, a
  Merges report section, and a `merge` event stage. Codes `LOOP_TARGET_NOT_BRANCH` and
  `WORKTREE_CREATION_FAILED` join the contract (`apiError.ts` + `l3-error-contract`).
- **Worktree-parallel runs refuse resumption** (`LOOP_RUN_INCOMPATIBLE`) — resuming mid-worktree is
  not implemented, and the refusal is explicit rather than a silent half-restore.
- **Tests (381 total):** `test/parallel-execution.test.ts` (new) uses a barrier stub to prove two
  implementer calls are airborne together before either answers, orders a dependent unit's first
  event after its dependency's merge event, and pins the stuck-keeps-branch and conflict-halts-the-
  line behaviors against real repositories. `test/loop-execution.test.ts` drops the obsolete
  `EXECUTION_MODE_UNSUPPORTED` arm for a real worktree-parallel completion.

## [4.13.23] - 2026-10-12 — the tracker bridge: an issue becomes a validated task document

A goal always had a way in (`GoalIntakeService`). A tracker issue had none: whoever wanted the loop
to pick up real work had to hand-transcribe the issue into a task document, losing the issue's
identity and any chance of traceability. WP-2 (Sprint 28) closes that gap with a bridge that reads
an issue from a tracker and drafts the task document through the *same* model contract and the
loop's own parser, so the resulting document is no more trusted than a goal-drafted one.

- **`IssueTrackerService` (new) reads one issue from either of two sources.**
  - `local` — a JSON object with a `title` (id/body/url/labels optional), or markdown with a `# `
    heading. The path must live inside the approved workspace (`ISSUE_LOCAL_PATH_OUTSIDE_WORKSPACE`
    otherwise). Something that cannot be an issue — an empty file, unparsable JSON, JSON with no
    title, prose with no heading — is refused (`ISSUE_LOCAL_FILE_INVALID`), never invented.
  - `github` — the GitHub REST API through the guarded egress path (`egressJson`) with a base URL
    that defaults to `https://api.github.com`. The token comes only from `resolveSecretRef`
    (`ISSUE_GITHUB_TOKEN_REQUIRED`), and the adapter refuses before any socket is opened when there
    is no allowlisted token. Statuses map explicitly: `404` → `ISSUE_GITHUB_NOT_FOUND`, `401/403` →
    `ISSUE_GITHUB_AUTH_FAILED`, a pull-request payload → `ISSUE_GITHUB_IS_PULL_REQUEST`, any other
    non-2xx → `ISSUE_GITHUB_FETCH_FAILED`, a body that is not an issue → `ISSUE_GITHUB_RESPONSE_INVALID`.
- **`IssueIntakeService` (new) is the bridge, and it is deliberately thin.** It fetches the issue,
  then drafts through `draftTaskDocument`, the same parser-validated core goal intake uses, so a
  draft an issue produces is validated-and-written exactly like a goal draft — unequal elsewheres
  would be two standards for the same trust boundary. `goalIntakeService.ts` now exports
  `draftTaskDocument` and `taskDocumentSystem`; the goal path is unchanged in behavior.
- **`POST /api/loop/issues` (new route)** mirrors the goals route: issue source, provider/model,
  repo, returns `201` with the validated draft plus the issue's identity.

**Evidence:** `test/issue-intake.test.ts` (new, 12 arms): both local formats read; empty/malformed/
not-a-title/prose refusals; outside-workspace refusal; unknown-source refusal; the GitHub adapter
refuses without a token *before* any lookup; repo/number shape guard; one issue read through the
guarded egress path against a loopback stub; status and shape mapping (404/401/403/503/non-issue/
pull-request); the bridge drafting a two-milestone document with the blocking edge preserved and the
parser accepting it; a parser-rejected draft refused (`LOOP_ISSUE_DRAFT_INVALID`); and the bridge
never reaching the model when the issue cannot be read. Failing-first was recorded: with the
JSON-title guard removed, the refusal arm goes red. Full suite: 377/377. All verify gates green.

**Honest limits:** the GitHub *real-network* success path is not exercised here — `api.github.com`
is not allowlisted in this environment, which is itself the point: without the operator's
allowlist the adapter fails closed. The status/parse contract is proven against a loopback stub.

## [4.13.22] - 2026-10-12 — the review runs two axes, and either one can refuse the commit

`ReviewService.review` asked one model read to judge a change on two unrelated questions at once —
"does this fit the repository's stated architecture?" and "does this unit's acceptance criteria
actually hold?" — and approve on a single boolean. The prompt listed both sets of rejection grounds,
but a single read weighs them against each other: a change that fits the repo beautifully and misses
a criterion, or satisfies every criterion by bending the design, could still come back `approved`.

- **The review now runs two independent model reads — `standards` and `spec` — each with its own
  system prompt, and the change is approved only when *both* approve.** `ReviewResult` gains `axes`
  (each axis's own verdict) and `approved` becomes the conjunction; findings are the union, each
  prefixed with the axis that raised it (`[standards] …`, `[spec] …`) so a refusal names who refused.
- **The axes are deliberately disjoint.** `standards` owns repository fit (architecture,
  duplication, stubs, unrelated files, secrets); `spec` owns criterion truth (criteria met only by the
  test, unrequested scope, gamed verification). Each prompt is told the other axis is a separate
  read that does not soften its verdict.
- **A malformed or refusing axis fails the whole review closed** — `Promise.all` rejects and the loop
  refuses the attempt, so a change is never approved because the axis that would have refused stayed
  silent. `AttemptRecord.review` records the per-axis verdicts so the report is traceable to the axis.
- The `review-approve` gate and commit service read the combined `approved`/`findings` unchanged; the
  loop reports both axes' verdicts in its run record.

**Evidence:** `test/review-two-axis.test.ts` (new, 4 arms): the two system prompts ask different
questions and each names its axis; a change that passes standards but fails spec is refused with a
`[spec]`-prefixed finding; a change refused by standards is refused even when spec approves; a change
both axes approve is approved with no findings — and each axis is dialled exactly once. **Failing-first:**
replacing `axes.every(...)` with `axes[0].approved` makes the spec-refusal arm fail (the spec axis is
ignored), then passes when restored. Full suite: **365/365**; `npm run verify` green (Layer 4 42/42).

## [4.13.21] - 2026-10-12 — the API execution boundary runs through the sandbox, and fails closed

ADR-010 recorded one open gap it did not close: `ExecutionBoundaryService.run` — the path behind
`POST /api/execution/:manifestId/run` — copied a source tree to a throwaway snapshot and ran the
detected verification profile with `execFileSync` directly. It confined the source path and
sanitized the environment, but ran no bwrap and did not unshare the network, so the manifest's
`network: 'disabled'` was a label, not an enforced state. A repository's own verification command
is arbitrary code, so this was a real execution path outside the boundary the loop enforces.

- **`run` now builds each profile step with `verificationStepCommand` and executes it through
  `groundTruthService.runCommand` with the doctrine sandbox and `DoctrineIsolationService.childEnv`,
  exactly as `executeVerification` does.** A command that cannot be sandboxed is refused, never run
  bare; a toolchain hidden by the sandbox is named (`SANDBOX_TOOLCHAIN_HIDDEN`), not dumped.
- **The manifest's `network` claim is derived from the doctrine** (`sandbox.enableNetwork`) instead
  of hardcoded `'disabled'`, so the record matches the state the sandbox actually enforces.

**Evidence:** `test/wp7-execution-boundary.test.ts` gains an arm that runs a manifest whose profile
step invokes a missing tool and asserts `run.passed === false` with a `SANDBOX_TOOLCHAIN_HIDDEN`
output. **Failing-first:** dropping the sandbox argument makes the arm fail — a bare `execFileSync`
never produces the sandbox refusal. Full suite: **361/361**.

## [4.13.20] - 2026-10-12 — the layer-4 gate reads the ledger version from source

`scripts/verify-layer4.sh` asserted the migrated ledger is rewritten at version `'5'` — a literal
left behind when `LEDGER_VERSION` moved to 6 and then 7. `npm run verify` was therefore red at HEAD
even though `npm test` was green: the unit migration arms tracked the constant, the shell gate did
not, so the "rewritten at the current version" check kept passing against a stale number.

- **The gate now reads `LEDGER_VERSION` from `src/services/durableStore.ts`** and refuses if it
  cannot, so the check tracks the code instead of a pinned literal that drifts on every bump.

**Evidence:** `npm run verify:layer4` — 42/42 (was 41/1). Full suite: **360/360**.

## [4.13.19] - 2026-10-12 — a replayed webhook is never byte-identical to the delivery it replays

`WebhookService.replay` re-signed the recorded body with `new Date().toISOString()`. The timestamp
is signed material (`signWebhook` hashes `${timestamp}.${body}`), so a replay issued in the same
millisecond as the original — routine under load — reproduced the original signature byte-for-byte.
A receiver that honours the timestamp window would read that as a captured delivery, and the
sprint's own arm ("a replay sends the identical body with a fresh, valid signature") failed
intermittently in the full suite while passing in isolation.

- **`replay` now stamps with `freshTimestampAfter(recorded.attemptedAt)`** — a new exported helper
  that advances one millisecond when the clock has not moved — so the replayed timestamp is
  strictly newer than the delivery it replays and the signature is always new. The contract the
  method already documented is now true regardless of clock resolution.

**Evidence:** `test/webhook-service.test.ts` gains a deterministic arm that seeds a delivery
timestamped at (just ahead of) the clock and asserts the replay is strictly newer with a different
signature. **Failing-first:** reverting to `new Date().toISOString()` fails that arm. Full suite:
**360/360**.

## [4.13.18] - 2026-10-12 — repository verification runs inside the sandbox, and never leaks the environment (WP-7 follow-up)

ADR-010 named one hole it deliberately did not close: `verificationProfileService.executeVerification`
— reached from the live route `POST /api/factory-jobs/:id/verify` via `FactoryJobService.verifyRepository`
— called `execFileSync` directly, outside bwrap. This closes it.

- **R-14 now covers the last bare execution path.** `executeVerification` builds each profile step
  as a shell command and runs it through `runCommand` with the doctrine sandbox, so a repository
  whose profile cannot be sandboxed is **refused**, exactly as the loop's verify stage is. The npm
  step expands to the script body and pins `PATH` to `/usr/bin:/bin:<repo>/node_modules/.bin`, so a
  toolchain the boundary would otherwise hide (the sandbox masks `/home`) is still reachable.
- **The verification process no longer inherits the operator's environment.** The first draft
  passed `{ ...process.env }`; `sandboxArgv` copies every entry onto the bwrap command line, which
  put live credentials into a world-readable argv. `executeVerification` now receives
  `DoctrineIsolationService.childEnv(...)` — the same scrubbed environment every loop-spawned
  process gets.
- **A failed sandbox command is named, not dumped.** `runCommand`'s sandbox branch fell back to
  `error.message` — `Command failed: <bwrap> <argv...>` — whenever a command exited non-zero with
  no output, persisting the whole command line into the verification record and letting a stray
  `NODE_ENV=test` be classified as a `TEST` failure. The fallback is now a bounded, argv-free
  condition; a genuinely silent failure stays `UNKNOWN`.
- **Failure classification stopped matching on incidental words.** `classifyFailure`'s
  `TYPECHECK` arm was loose (`/type|tsc|compile/` matched any "type"); it now requires a
  typecheck/tsc/compile/`error TS` token.

**Evidence:** `test/wp7-verify-profile-sandbox.test.ts` (6 arms) — a missing bwrap binary refuses;
a real profile runs sandboxed; the service contains no `execFileSync`/`spawn`; the spawned process
does not see an ambient `SF_LEAK_CANARY`; and a failing step reports a named condition with no
`--setenv`/`Command failed:` in the output. **Failing-first:** forwarding `process.env` fails the
no-inherit arm; restoring the `error.message` fallback fails the no-dump arm; reverting the sandbox
routing fails the source-invariant arm. `harness.test.ts` (bounded repair) is green again now that
classification reads the command's output instead of its argv. ADR-010's open gap is closed and the
record updated. Full suite: **359/359**.

## [4.13.17] - 2026-10-12 — a record id never collapses two records (WP-10 hardening)

`DurableStore.id` hashed `${entropy}:${Date.now()}:${process.pid}`. When a caller's `entropy` is
itself a millisecond timestamp — `UsageMeteringService.record` passes the event's ISO time — two
records minted in the same millisecond hashed to the same id. `record` treats an existing id as a
replay, so the second event was **silently dropped**: usage was undercounted, and the daily token
budget (WP-6) is enforced against that count. A meter that quietly loses events is not a meter.

- **`DurableStore.id` folds a monotonic per-process counter into the digest**, so an id can never
  repeat within a process regardless of clock resolution. `deterministicId` — the deliberate
  content-addressed id used for replay protection — is unchanged.

**Evidence:** `test/wp10-usage-metering.test.ts` gains a 50-event burst arm that records fifty
events in a tight loop and asserts all fifty are kept. **Failing-first:** removing the counter
collapses the burst below fifty. Full suite: **353/353**.

## [4.13.14] - 2026-10-11 — the daily AI-token budget is enforced at the spend boundary (WP-6, as renumbered)

WP-10 part 1 built the meter and deliberately deferred capping until a budget could be exercised
against real model usage. This layer ties the meter to the boundary that spends.

- **`PipelineOrchestrator.execute`** refuses a cycle before the model is called once the tenant's
  metered usage for today meets or exceeds `maxDailyAiTokens` — `AI_BUDGET_EXCEEDED` (429) with
  a `Retry-After` reaching the next UTC midnight. The refused cycle never calls the model,
  records no spend, and writes no transformation record.
- **`usageMeteringService.budgetState`** answers *is the allowance spent?* against the durable
  `usageEvents` ledger and never throws: a principal with no measurable allowance is reported as
  spent/unknown (`AI_BUDGET_UNKNOWN`, 500) so the boundary fails closed instead of running
  unbudgeted.
- **`utils/apiError.ts`** registers `AI_BUDGET_EXCEEDED` (429) and `AI_BUDGET_UNKNOWN` (500);
  `utils/operationalError.ts` adds both to the typed `OperationalErrorCode`.
- **`test/wp6-budget-guard.test.ts`** (5 arms) — under-budget runs; a spent tenant is refused
  before enrichment (model never called, 429, Retry-After within a day, no record, no spend);
  `consumed == allowance` is spent; an unknown principal fails closed; and the live
  `POST /api/telemetry/ingest` answers a spent tenant with 429 on the wire. **Failing-first:**
  deleting the guard lets the spent tenant reach the model; `exhausted: false` for a full tenant
  fails the retaliation arm. Full suite: **345/345**.

## [4.13.15] - 2026-10-11 — operator cap & audit controls (WP-5, as renumbered)

Concurrency came from the tier in code; the AI-token budget came from the quota at
registration. Neither could change at runtime, and a change to either would have been silent.
This adds the operator's durable handle on both.

- **`src/services/operatorCapService.ts`** — a per-tenant override (`concurrency`,
  `dailyAiTokens`) persisted in a new `operatorCaps` durable collection (ledger bumped to v7
  with the same additive migration as `usageEvents`), attributable via `updatedBy` and a
  bumping `revision`.
- **Tighten-only by construction.** `set` refuses a value above the base re-derived from the
  live tenant profile (`OPERATOR_CAP_NOT_TIGHTENING`); every consumer reads the effective cap
  as `Math.min(base, override)`, so even an override that slips past validation can only shrink
  a cap, never grow it. `clear` restores the base.
- **Enforced at the real boundaries.** `TenantQueueService.limitFor`/`admit` bind the
  concurrency path; `usageMeteringService.budgetState` binds the allowance the daily budget is
  enforced against.
- **`src/api/routes/operator.routes.ts`** — `GET/POST/DELETE /api/operator/tenants/:id/caps`,
  platform-operator only (`OPERATOR_ROLE_REQUIRED`); every successful change writes a
  `tenant.cap.change` audit event (durable, attributable) via `recordAuditEvent`.
- **`DurableStore.delete`** added for the override clear path.
- **`test/wp5-operator-caps.test.ts`** (6 arms) — tighten-only refusal; a written cap is durable
  across a reload, attributable, and binds `limitFor`/`budgetState` (clear restores the base); a
  rogue override planted in the ledger clamps to `min` and cannot raise a cap; live route
  refuses a tenant credential with 403 and applies a platform operator's set/clear with audit
  events. `l3-error-contract` registers the four new codes. Full suite: **351/351**.

## [4.13.16] - 2026-10-11 — ledger migration arm for v7 and the WP-7 secret gate made true-green

Hardening pass over the new layers and the two gates the sprint promises to keep green.

- **`test/l4-durable-tenancy.test.ts`** gains the version-6 → 7 migration arm, completing the
  ladder the ledger claims: every past version is read, migrated forward, and rewritten at
  `LEDGER_VERSION`, and the new `operatorCaps` collection is coerced to empty, never absent.
  Additive migrations do not quarantine old ledgers.
- **`scripts/verify-no-secrets.sh`** — the WP-7 gate was red before this sprint: the WP-8
  fixture plants the AWS *documented example* key `AKIAIOSFODNN7EXAMPLE` on purpose, and the
  index scan flagged it. Since every secret shape the product scan detects is also a gate
  pattern (there is no disjoint value), the gate now exempts **only** that vendor-published
  example string, and only when *every* AWS-shaped match in the file is it — a file that also
  contains any other `AKIA…` value is still blocked (verified with a planted-real-key negative
  control). The gate is green again without masking what it exists to catch.

## [4.13.13] - 2026-10-11 — per-tenant queue isolation and fair-share (WP-10, part 2)

The resource governor capped *host* concurrency but had no notion of who was asking, so one
tenant with many repositories could take every admitted slot. The global cap was a race, not a
guarantee.

- **`src/services/tenantQueueService.ts`** — per-tenant admission decided before any work
  starts. A tier-derived cap (starter 1, professional 2, enterprise 4; an environment value may
  only tighten), fair-share `floor(globalCap / competitors)` so no single tenant can take the
  whole host when others compete, and a conservative cap for a tenant the registry does not know
  — never a wave-through.
- **Enforced at the real boundary.** `LoopControlService.submit` reserves a per-tenant slot
  before the loop starts and releases it when the run settles, or when the run refuses before
  creating a record. A tenant at its share is refused `TENANT_CONCURRENCY_LIMIT` (409) by name,
  never queued silently.
- **`src/utils/apiError.ts`** — registers `TENANT_CONCURRENCY_LIMIT` (409) plus the internal
  `TENANT_QUEUE_LEASE_*` faults (500); `test/l3-error-contract.test.ts` now names the new code.
- **`test/wp10-tenant-queue.test.ts`** (6 arms) — tier caps, host-cap-beats-tier, fair-share
  under competition, release frees the slot, and the live submit path reserving/refusing/
  releasing. **Failing-first:** removing the acquire in `submit` lets an overloaded submission
  through; removing the settle-path release leaves the tenant's count stuck. Full suite:
  **340/340**.

## [4.13.12] - 2026-10-10 — per-tenant usage is metered from what was actually consumed (WP-10, part 1)

Every tier declared a `maxDailyAiTokens` budget and nothing ever read it. A budget with no meter
is unenforceable, and the meter could not be built on the numbers the code reported, because they
were fabricated: the deterministic fallback claimed `tokensUsed: 420` and the live path defaulted
to `|| 512` when the provider returned no usage.

- **`src/services/usageMeteringService.ts`** — a durable per-tenant, per-UTC-day meter.
  Records only observed usage; refuses a figure that is not a non-negative integer
  (`USAGE_TOKENS_INVALID`) rather than rounding it; and is idempotent on
  `(tenant, source, correlationId)` via `DurableStore.deterministicId`, so a retry cannot
  double-count.
- **Token honesty.** `geminiService` now reports `tokensUsed: 0` on the no-key fallback and
  `result.usage?.totalTokenCount ?? 0` on the live path — no fabricated constant.
- **Wired to the real path.** `pipelineOrchestrator` meters the enrichment's reported tokens on
  every cycle, keyed on the correlation id.
- **`GET /api/usage`** — the caller's own metered consumption; answers for the authenticated
  principal only (no `?tenantId=`).
- Ledger version 5 → 6 adds the `usageEvents` collection; a v5 document migrates forward and
  loses nothing (additive, like v4 → v5).
- **Enforcement is deliberately out of scope**: the daily budget can only be exercised against
  real model usage, which lands with WP-5. This layer measures; it does not yet cap.
- **`test/wp10-usage-metering.test.ts`** (7 arms). **Failing-first:** restoring `tokensUsed: 420`
  fails the honesty arms (2/7); removing the orchestrator's record call fails the wiring arm;
  breaking idempotency fails the retry arm. `l4-durable-tenancy.test.ts` gains a v5 → v6
  migration arm. Full suite: **334/334**.

## [4.13.11] - 2026-10-10 — restore is proven to return the data, and the service is load-tested (WP-9)

The CI pipeline is already the gate (typecheck, `npm test`, build, layers 1–4, secrets, release,
docs, Rust), and a checksummed backup/restore already existed. But the restore test only asserted
that a *checksum* came back — it would have passed even if `restore` never touched the live
ledger. And nothing fired concurrent requests at the real API and checked that none were lost.

- **`test/workspace-lifecycle.test.ts`** — backup, then create a second job *after* the backup,
  then restore, and assert the post-backup job is **gone** and the original remains. "Restore
  returns the data" now means the live document reverts. **Failing-first:** removing
  `DurableStore.replaceDocument` from `WorkspaceService.restore` fails the test.
- **`test/wp9-load.test.ts`** — boots the real app on an ephemeral port and fires **60 concurrent**
  `POST /api/factory-jobs` over the real transport, then asserts every one succeeded, the ledger
  holds exactly 60 unique records, and they survive dropping the in-memory copy and re-hydrating
  from disk. **Failing-first:** a store that drops an interleaved write makes the count assertion
  fail. Both tests run under the existing `npm test` step, so the pipeline is the gate for them.
  Full suite: **326/326**.

## [4.13.10] - 2026-10-10 — the quality score measures the product, not its metadata (WP-8)

`FactoryJobService.recordLaunchQuality` persisted a 0–100 score whose every dimension was a
function of *which metadata objects were present* on the job. A job whose verification failed
but whose evidence list held a `security-*` line still collected the security points. The
number looked measured and was not.

- **`src/services/productEvaluationService.ts`** — `evaluateProduct(signals)`, a pure function
  over observed signals. It keeps the existing five dimensions and weights (verification 25,
  security 20, evidence 20, operability 15, productDiscipline 20) so history stays comparable,
  fails closed (an unobserved dimension scores 0, not full marks), reacts to real badness
  (blocked scan, failed verification, empty diff, rejected review, stuck units), and returns a
  named `reasons` list for every deduction.
- **`recordLaunchQuality` delegates.** It builds signals from the job and calls the evaluator.
  A `SECURITY` verification failure is a real `BLOCKED` signal; metadata-only absence fails
  closed.
- **`test/wp8-product-evaluation.test.ts`** — the known-bad product (verification failed, real
  security scan `BLOCKED`, review rejected) scores `< 40`; a clean product scores 100; a real
  temp git repo with a planted AWS key is scanned by the **real** `QualityGateService.scan` and
  scores low. **Failing-first:** reverting `recordLaunchQuality` to the old presence-based rubric
  makes the known-bad job score 45 and fails the e2e arm; reverting the security fail-closed
  branch fails 3/5 arms. Full suite: **325/325**.

## [4.13.9] - 2026-10-10 — the execution boundary is recorded and enforced (WP-7)

The factory runs commands on repositories it did not author. It carried an isolation mechanism
and escape tests for several sprints, but no ADR named the boundary, its scope, or its holes —
and one hole let the doctrine switch the sandbox off.

- **`ADR-010: The execution boundary is bwrap, and escape is asserted`** (Accepted) records the
  three distinct mechanisms honestly: the loop's bwrap sandbox (the strong one), the
  `ExecutionBoundaryService` snapshot/env boundary (no bwrap, no network unshare), and the
  `SandboxPolicyService` policy registry (executes nothing). It names the open gaps.
- **The sandbox can no longer be disabled.** `parseLoopConfig` refused nothing before, but
  `runCommand` fell through to a bare `sh -c` whenever `sandbox.enabled` was false — R-14 in
  prose, breakable in config. A doctrine that disables the sandbox is now refused at load
  (`src/services/doctrineService.ts`), so the loop can never run a verification command bare.
- **Path containment decides on real paths.** `ExecutionBoundaryService.createManifest` and
  `SandboxPolicyService.createPolicy` re-implemented containment as a `path.resolve` prefix
  comparison, which a symlink inside the workspace defeats. Both now route through
  `pathGuard.resolveWithin` — the canonical guard whose own header warns that a duplicated
  check is a chance to forget symlink resolution.
- **`test/wp7-execution-boundary.test.ts`** — the doctrine-disabled refusal, plus traversal and
  symlink-escape refusal on both boundary services and `pathGuard`. **Failing-first:** reverting
  the doctrine guard fails arm 1; reverting the two services fails the symlink arms (2/6).
  Full suite: **320/320**.

**Named open gap (in ADR-010):** `verificationProfileService.executeVerification` runs
unsandboxed via `POST /api/factory-jobs/:id/verify`. Highest-priority follow-up.

## [4.13.8] - 2026-10-10 — the tenant registry is no longer a cross-tenant read hole (WP-4)

`GET /api/tenants` returned every partition to any authenticated caller, and
`GET /api/tenants/:id` read the id straight from the path and returned that tenant's quota
and guardrails — with no check that the id was the caller's own. `validateTenantRequest`
inspects the header/body/query claim and never `req.params`, so it could not have caught
this even had the route called it. Any root or admin-scoped credential could enumerate
every tenant and read any tenant's profile: a cross-tenant read.

- **The registry is tenant-bound.** `GET /api/tenants` returns all partitions only to a
  `platform_operator`; a tenant credential sees exactly its own. `GET /api/tenants/:id`
  refuses with `TENANT_CREDENTIAL_MISMATCH` unless the id is the caller's own or the caller
  is a `platform_operator` (`src/api/routes/tenants.routes.ts`).
- **Auth honesty.** `src/services/rbacService.ts` claimed a `requirePermission` guard "called
  by routes". No such guard exists and `RbacService.check` is called by no route; the
  enforced boundary is the credential-scope check in `tenantAuthMiddleware`. The doc now
  states what is actually enforced and names route-level role enforcement as a follow-up.
- **Scoped-credential durability proof.** `test/l4-durable-tenancy.test.ts` now shows a
  provisioned scoped key survives a simulated restart with its grant, and a revoked one stays
  revoked — previously only root keys had restart coverage.
- **`test/wp4-cross-tenant-read.test.ts`** drives the real router with real provisioned
  tenants: list-isolation, read-by-id refusal (403), own-profile read (200), platform
  enumeration, and foreign-`?tenantId=` refusal on `/api/telemetry/history` and `/audit`.
  **Failing-first:** reverting `tenants.routes.ts` fails 2/7. Full suite: **314/314**.

## [4.13.7] - 2026-10-10 — the audit trail reports the enrichment's real resilience context

Every persisted transformation claimed `retryAttempts: 0` and
`circuitBreakerStatus: 'CLOSED'` — the orchestrator wrote those constants
(`src/services/pipelineOrchestrator.ts`). So a request that had just been retried three
times through the Gemini circuit breaker, or one that was answered while the breaker sat
`HALF_OPEN`, was recorded as "no retries, breaker healthy". The fields looked measured and
were not.

- **The real values are now threaded through.** `GeminiService.transformTelemetry` returns
  the attempt count from `withExponentialBackoff` and `circuitBreaker.getState()` — the live
  breaker state — and the orchestrator records those in the transformation's audit trail
  (`src/services/geminiService.ts`, `src/services/pipelineOrchestrator.ts`).
- **`UNKNOWN` is a first-class state.** A legacy row written before the field existed has no
  knowable breaker state; `TransformationAuditTrail` now allows `'UNKNOWN'` and the store
  uses it instead of the `'UNKNOWN' as never` type lie (`src/models/telemetry.ts`,
  `src/services/telemetryStore.ts`).
- **`test/orchestrator-audit-truth.test.ts`** drives the real orchestrator with an enrichment
  stub that reports `attempts: 3`, `circuitBreakerState: 'HALF_OPEN'`, and asserts the
  persisted record carries those values. **Failing-first:** reverting the orchestrator to the
  constants fails the test. Full suite: **305/305**.

## [4.13.6] - 2026-10-10 — the ingest path fails closed when the ledger refuses the write

Every persistence test proved the happy path — a write lands, a replay deduplicates, the
ledger survives a restart. None proved the failure path. So when the raw write threw, the
ingest route fell through `classifyDependencyFailure`'s default branch, which answers *"the
telemetry record was accepted but structured enrichment failed"* while setting
`rawPayloadPersisted: false`. The message asserted the acceptance the flag denied: a caller
would read it and not retry a record that was, in fact, lost.

- **The raw write is now named as a ledger fault.** A failure at layer 3
  (`AppwriteService.recordTelemetryEvent`) is wrapped in an explicit
  `OperationalError('LEDGER_UNAVAILABLE', …, 503, { rawPayloadPersisted: false })`, so the
  response says the record could not be persisted and nothing was stored — never that it
  was accepted. `src/services/pipelineOrchestrator.ts`.
- **`test/ingest-fails-closed.test.ts`** drives the real router with a real provisioned
  tenant and injects a failing store: the response must be a non-2xx `LEDGER_UNAVAILABLE`
  with `rawPayloadPersisted: false`, no success artefact and no claim of acceptance; a
  healthy ledger must not be reported as a ledger fault. **Failing-first:** against the
  previous code the failure was `ENRICHMENT_DEGRADED` (3 pass / 1 fail); with the fix,
  3/3. Full suite: **304/304**.
- **Still open (blocked):** proving idempotent persistence against *real Appwrite* needs a
  reachable endpoint and a provisioned database. `scripts/e2e-tenant-roundtrip.ts` is the
  harness, but `fra.cloud.appwrite.io` times out from this host, so the real-backend write
  path cannot be exercised here — the local durable store's write/restart/idempotency is
  already covered by `test/founder-mode.test.ts` and `test/l4-durable-tenancy.test.ts`.

## [4.13.5] - 2026-10-10 — the error view stops inventing a Rust panic

The stream tab showed a "Raw Rust Backend Error Stack Trace" for errors raised by
the Node control plane. The frames were generated in the browser with
`Math.random()` — a random worker id, a random panic line, a canned `rustc`
backtrace and a fixed register dump — so the UI manufactured diagnostic evidence
that matched no failure that ever happened. In an error path that is the worst
place to fabricate: the operator reads a confident-looking stack trace and
believes it.

The product does ship a Rust crate (`software_factory/`, Axum + Tokio), but the
running service is the Node control plane and it emits no Rust traces. Where a
real trace is unavailable, the honest move is to show the real error envelope.

- **Deleted the synthesizer** — `generateRustStackTrace`, `RustStackTraceInfo`,
  `RustStackFrame` and the `rustTrace` field are gone (`src/utils/validation.ts`).
  A `StandardErrorResponse` is now `{ status, code, message, details? }` and nothing else.
- **The error view shows the real envelope** — error code, correlation id, tenant and the
  server message, with the note that this is the Node control plane and no stack trace is
  synthesized. Removed the panic origin, scheduler runtime, `RUST_BACKTRACE=full` badge,
  `RAX/RBX/RIP/RSP` register snapshot and the fake `[tokio-worker-12]` success log; the
  success trace now prints the real correlation id, tenant, record id, guardrails and latency.
- **ADR-003 and the Sprint-04 label are kept**: the Rust crate is real and tracked, so the
  governance record of it is true. Only the client-side *simulation* was false.
- **`test/error-trace-truthfulness.test.ts`** — the emitter carries no trace field, and the
  UI holds none of the source-level diagnostic tokens. Failing-first recorded for both arms.
  Full suite: **301/301**.

## [4.13.4] - 2026-10-10 — the product says which build it is, and what it actually runs

A live URL gave no way to tell which build was serving it, and the dashboard
invented a Rust/Tokio runtime the Node service does not run.

- **The build now reports its own identity** (`src/configurations/buildInfo.ts`). Reads
  `package.json` at runtime, checks the package `name` before trusting the manifest,
  resolves against both the working directory and the entrypoint, and reports `unknown`
  rather than guessing. `/api/factory/health` returns `name` and `version`; the UI header
  badge is fed by that field instead of the literal `v3.2.0-PROD`.
- **`test/health-version.test.ts`** asserts the payload version equals the real
  `package.json` version. Failing-first: reverted to a constant, the test fails.
- **The health board stopped inventing a runtime.** It read
  `systemHealth.threadpool.*`/`circuitBreakers`/`kubernetes`, none of which the API sends;
  the throw was swallowed and the board rendered nothing. Removed the fabricated
  threadpool, jemalloc heap, trippable circuit breakers and HPA pod counts; the board now
  renders only `classifyReadiness()` and `process.memoryUsage()` — status, readiness
  checks, heap/RSS/pressure, uptime and the deployed version. Deleted the dead fabricated
  components (`TelemetryHealthBar`, `RustMetricsCharts`, `LatencyHeatmap`) and the
  "Rust Tokio Engine" tab.
- **`test/health-truthfulness.test.ts`** — the payload carries only measurable fields and
  none of the invented ones, and the health UI source contains no fabricated-runtime
  tokens. Failing-first recorded for both arms. Full suite: **299/299**.

## [4.13.3] - 2026-10-10 — the Docker self-host route

Railway is the hosted route, and it is unpaid. The same image now runs on a
single Docker host with one command and a persistent volume, so the product no
longer depends on a paid platform.

- **`docker-compose.yml`** — builds the existing `Dockerfile`, publishes the
  server on `8080`, mounts the named volume `sf-data` at `/data` (durable store,
  backups, previews, releases, loop reports), health-checks `/api/factory/health`,
  and forbids privilege escalation (`no-new-privileges`). It reads `.env.docker`
  only — never the developer's `.env` — so a dev-only `ALLOW_INSECURE_LOCAL=true`
  cannot leak into a production container, and the flag is forced off.
- **`docs/DEPLOY_DOCKER.md`** — first run, durability proof, upgrade, stop/wipe.
- **Verified:** image builds; container reports `healthy`; `durableStore: healthy`;
  `configuration: degraded` (the honest fail-closed default with no Appwrite or
  tenant credentials configured); the SPA is served; the durable store's archive
  advanced across `docker compose restart`, proving the volume persists state.
- **Fail-closed proven:** when the dev `.env` was inherited, the app refused to
  start (exit 78) on `ALLOW_INSECURE_LOCAL=true`; the compose was corrected to
  not read it.

## [4.13.2] - 2026-10-09 — the first run against a real external repository

FundiOS, cloned, driven end to end by the loop. It found a defect that a green suite never could,
because every fixture wrote a flat file into a repository root.

- **A new file in a new directory was wrongly refused** (`groundTruthService`, `executionLoopService`).
  `git status --porcelain` collapses an untracked directory to a single `?? dir/` entry, so the
  ground-truth path list held `docs/verification/` where the gate was asked about
  `docs/verification/proof.md`. The `claimed-files-exist` gate then refused every attempt with
  "claimed file is unchanged from HEAD", the unit went STUCK after the attempt cap, and a perfectly
  ordinary change never committed. Fixed at the root: path enumeration now uses
  `--untracked-files=all`, in both the ground-truth service and the loop's rollback snapshot
  (`treePaths`). A Daftari run had never hit it because its units edited existing files.
- **`scripts/verify-fundios-e2e.ts`** (`npm run verify:fundios -- --repo <scratch clone>`). Drives
  the real `GoalIntakeService.draft` and `ExecutionLoopService.run` against a real clone with a
  local stub model port, and asserts on git history — one commit, the `Verified:` / `Proof:` /
  `AI-Assisted:` trailers, the file on disk, and a clean tree. Idempotent: it resets the scratch
  clone to its upstream first, so a re-run does not trip the `no-op-unit` gate. This is the
  command behind the claim that the loop works on a repository it has never seen.
- **Evidence:** `artifacts/sprint-26/fundios-e2e-evidence.txt` — `completed`, unit `M1:done`,
  21 gates executed and 0 refused, commit `0265c7a4a9bb` carrying the verified trailers.
- **Failing-first:** `test/loop-execution.test.ts` gains "a unit that creates a new file inside a
  new directory is committed, not refused". Observed failing with the fix reverted (1 fail), passing
  with it (1 pass). Full suite: **296/296**.

## [4.13.1] - 2026-10-08 — deploy fixes found by the first live Railway rollout

Three defects, all found by taking 4.13.0 to a real host instead of a green local suite.

- **The startup banner denied three settings that work** (`33b2f42`). The banner warned that
  `FACTORY_ENFORCEMENT_MODE`, `FACTORY_DOCTRINE_ROOT` and `FACTORY_LOOP_REPORT_DIR` are "not a
  recognised setting and ha[ve] NO effect". All three are read by real code — `whoami` reports the
  enforcement mode, `doctrineService` loads rules from the doctrine root, and
  `executionLoopService` writes run reports to the report directory. A warning that says a working
  setting does nothing is worse than no warning: it would lead an operator to remove a setting that
  is in use. The banner must not claim a capability the system lacks, and must not deny one it has.
- **The service could not write its own volume** (`3be55be`). The image ran as the unprivileged
  `factory` user, and Railway mounts its volume as `root:root` over the data directory, which an
  unprivileged process cannot chown. The ledger was therefore unwritable and the service correctly
  refused to serve — `EACCES: permission denied, open '/data/software-factory.json.lock'`. The fix
  is NOT to run the service as root: `docker-entrypoint.sh` starts as root only if the container
  did, chowns the data directory, and drops to `factory` via `setpriv` before exec'ing the server.
  A container already started as a non-root user execs straight through with nothing escalated.
- **Leaked reasoning text in `CHANGELOG.md`** (this release). A prior session committed a block of
  model reasoning — including a raw pseudo tool-call — into the 4.11.0 section. Removed, and the
  tree scanned for other artifacts (`git grep -nE "DSML|</think|invoke name="`): none remain.

- **First live deployment.** Railway service `Forge` (project `forge`) now builds from
  `dmuhoro/Software-Factory@main`, mounts a persistent volume at `/data`, and reports
  `status: Online` with `/api/factory/health` returning 200 and `durableStore: healthy`. The
  remaining `configuration: degraded` is the honest fail-closed default (no model secret refs
  permitted, no tenants provisioned), not an error.

### Sprint 25 — borrowed leverage (complete, released as 4.13.0)

Shapes borrowed from WorkOS, inverted where SF's safety model requires it. Full plan and
verified ground truth in `sprints/sprint-25-borrowed-leverage.md`.

- **Ground truth recorded** (`698f164`). WorkOS MCP (OAuth, 4 tools, 188 queries + 183
  mutations) and Appwrite MCP (1 database, 4 tables, 0 buckets, 0 users, **0 API keys**) probed
  live and read-only; the full WorkOS catalogue is at `artifacts/sprint-25/workos-catalog.md`.
  Two findings recorded rather than papered over: SF's live Appwrite credential is dead (401, and
  the project has no keys at all — operator-blocked), and a static `Authorization` header on a
  remote MCP defeats its OAuth session.
- **Two-phase confirmation for irreversible control-plane operations** (`5cfb42c`).
  `ConfirmationService` issues single-use, TTL-bound, scope-bound tokens; a wrong guess
  invalidates a live confirmation so it cannot be brute-forced. Tokens live in memory, not the
  ledger — a pending confirmation is a conversation with one caller, not a fact about the world.
- **Run cancellation is cooperative and only at a unit boundary.** The loop is the only writer of
  the target tree, so stopping it mid-write would leave a tree nothing can vouch for.
  `POST /api/loop/runs/:id/cancel` takes two calls: phase one returns a token and does nothing;
  phase two consumes it and the run stops. Commits already made are kept.
- **Eligibility is answered before the operation** (`5cfb42c`, shape from WorkOS
  `workspaceDeletionCheck`). `GET /api/loop/runs/:id/cancel` reports whether a run may be stopped
  and why not, without touching it.
- **The 4.12.0 lockfile drift is fixed** (`da90cfe`): `package-lock.json` still said 4.11.0,
  failing NC-3. A release that cannot be installed from a clean clone is not a release.
- **Scoped, expiring tenant credentials** (`1bf7e59`). A tenant keeps exactly one root
  credential; an integration gets a scoped one that expires on its own, carries an explicit
  grant, and can be revoked without disturbing the root or its siblings. The scope requirement is
  derived from the request and is a closed set — anything that is not a recognised loop route
  demands `admin`, so adding a route denies every scoped key until a matching scope is granted on
  purpose. The check sits in `tenantAuthMiddleware`, in front of every protected route.
- **Graduated enforcement with no switch that turns it off** (`9612bf2`). WorkOS ships
  `upsertActionsEndpoint(failOpen)`; SF does not borrow it. `off` is refused in every
  environment, and anything unrecognised resolves to `enforce`. `log-only` records what it would
  have refused, attributed to a named rule, and governs advisory checks only — a hard safety gate
  has no mode.
- **Audit event schema validation and preview** (`fad30db`). Eight named rules; all reported at
  once, not one per round-trip. `preview` answers what an event would do without writing anything.
  Graded under the phase-4 mode: `enforce` refuses and the sink is never called; `log-only` writes
  and returns the waived rules so the trail records that it arrived unvalidated.
- **Signed outbound webhooks** (`6b76528`). HMAC-SHA256 over `timestamp.body`, so a captured body
  re-sent later is refused. Subscription URLs are validated at registration **and again immediately
  before every send** (DNS rebinding). No unbounded retry loop: a failing receiver is recorded once
  and a human replays what matters. `replay` sends the identical recorded bytes with a fresh
  signature — an operator resending, not an attacker replaying.
- **Resource-scoped RBAC** (`f5dd000`). principal → role → permission → resource, and both halves
  must pass. A binding names the repositories it covers, so a global cancel right is not the default
  anyone falls into. A scoped credential is a viewer by default and cannot escalate by being scoped
  to `admin`.
- **Self-describing authorisation** (`323c7df`). `GET /api/whoami` reports the caller's tenant,
  credential kind, scopes, role and permissions — and is **scope-free**, because a `loop:read`
  credential must be able to ask what it is. The operator panel now asks the server rather than
  assuming, and disables controls the credential cannot use.
- **Release 4.13.0**: version and lockfile bumped together, so NC-3 cannot drift as it did at 4.12.0.
- Full suite: **295/295** passing (230 at sprint-24 close + 65 new); `tsc --noEmit` clean; build clean.

#### Two defects the phases themselves found

- `RBAC_NO_ROLE_BINDING` was unreachable: the role fallback meant a principal always had a role, so
  the refusal could never fire. A refusal that can never fire is a claim of protection the code does
  not provide, so the unrecognised-kind case is now refused rather than defaulted.
- `whoami` demanded `admin`, so a `loop:read` credential could not ask what it is. The test failed,
  which is how it was found.
- `UNAUTHORIZED` had no entry in `DOMAIN_ERRORS` and would have degraded to a 500; the `l3`
  path-guard scan surfaced it.

### Sprint 24 — remote control plane (in progress)

- **Single-writer lock proven across processes** (`d141f4b`): a second process against one data
  directory is refused with `LEDGER_ANOTHER_WRITER_ACTIVE`, pinned by
  `test/durable-store-writer-lock.test.ts` and `scripts/durable-writer-probe.ts`. The Railway
  deploy contract (one replica, persistent volume, hosted provider) is documented in
  `docs/DEPLOY_RAILWAY.md` with `railway.json`.
- **The unattended loop is reachable over authenticated HTTP** (`3b124a5`). `LoopControlService`
  validates the repository (inside the approved workspace, a git repository) and starts the real
  `ExecutionLoopService`. New tenant-authenticated routes: `POST /api/loop/runs` (202),
  `GET /api/loop/runs`, `GET /api/loop/runs/:id`, and an SSE `GET /api/loop/runs/:id/events`.
  A run submitted by one tenant is invisible to another.
- **A goal becomes a task document the loop accepts** (`2198b44`). `GoalIntakeService` drafts the
  document with the tenant's chosen model and refuses any draft the loop's own parser rejects
  (`LOOP_GOAL_DRAFT_INVALID`). The Models section is dictated from the registered assignment, so a
  draft can never aim the loop at an unregistered provider. `POST /api/loop/goals` (201).
- **Operator panel in the React UI**: a new Unattended Loop tab lists runs, submits a
  run, drafts a goal, and tails the live SSE stream. The API key the operator pastes is held in
  component memory only — never written to storage or the URL — and is dropped on unmount.
- Full suite: 230/230 passing; `tsc --noEmit` clean.
- **Release 4.12.0**: tagged and pushed to GitHub.
- **RAM-only token MV3 extension**: `clients/forge-style-extension/` (Manifest V3). Token/tenant are held in memory only; popup explicitly states this. Host permissions are configurable per deployment.


## [4.11.0] - 2026-10-07

- **All five sprint-22 open findings closed, each with a failing-first test and a replay against
  the real artifact it came from.**
  - **Opaque exit-1 refusals → named codes** (commit `3fbabf2`): 35 message-only domain errors now
    carry a code. A refusal that reached a terminal as a bare sentence is now
    `SOMETHING_NAMED`. Test `test/l3-error-contract.test.ts` scans every throw form.
  - **Command feedback carries file:line** (commit `98bebdf`): a failed verification command's
    `outputTail` is mined for file/line (`extractLocators`) and appended to the next attempt's
    refusal, so the model is told where to look.
  - **`diff:comment-claim`** (commit `22e4c81`): an added comment must not name a value the line it
    annotates does not use. Replayed against the false `tenantId: ''` comment from `c5d6a47`,
    refused at `scripts/run-pilot.ts:17` with `proof.passed=false`.
  - **`no-op-unit`** (commit `3d24567`): a unit whose own verification command already exits 0 on
    the starting tree is refused once, before the model is dialled, instead of burning the attempt
    cap. The loop treats it as terminal. Replayed against the vacuous Daftari M2.
  - **`SANDBOX_TOOLCHAIN_HIDDEN`** (commit `1eb653b`): a sandboxed command that exits 127 because
    the sandbox masked its toolchain (the `/home`-hidden `npm` from the first self-dogfood run) is
    named at the boundary that observed it and treated as terminal. Replayed with the exact
    pre-remediation M1 verify command from `30a1bf5`.
- **Adversarial review's true scope documented** (`docs/ADVERSARIAL_REVIEW_SCOPE.md`, commit
  `8152ff0`): what the reviewer reads, its seven rejection rules, and an explicit statement of
  what it is **not** — not a security audit, not a correctness proof, not independent verification
  (same model family possible), probabilistic, and truncated at 60,000 diff characters.
- **Die-and-resume drill, live:** run `looprun_875b855f07096ade7d02c68d` was SIGKILLed between
  `verify.before` and `verify.after` (no commit, one untracked path), then resumed with
  `--resume` — the run restored the interrupted path to its last committed state and produced
  exactly one commit (`7d53719cff8b`), status COMPLETED, 25 gates, 0 refused. A first, accidental
  drill run (`looprun_3a8160da31a7d5884bdd6fd9`) additionally proved the reviewer refuses an
  unrelated-file change: it refused an untracked `verify-ran` residue on all three attempts.
- **Real throughput batch on Daftari:** run `looprun_e8c12bcd603a16fe1dd9d02c68d`, task
  `tasks/daftari-throughput-i18n-batch.md` — 4 independent real i18n units, **4/4 committed on
  attempt 1**, 66 gates executed, 0 refused, 217.6s wall (54.4s/unit, ≈66 units/hour) on a local
  `gpt-oss:20b-cloud`. Daftari HEAD `a2457dbe`; `check-i18n` (430/430 keys) and `tsc --noEmit`
  both green.
- README updated to name only proven capabilities and to link the review scope document.
- Release 4.11.0: version bump 4.10.3 → 4.11.0, this CHANGELOG entry, annotated tag `v4.11.0`;
  full suite and lint green.

## [4.10.3] - 2026-10-07

- **New ground-truth check `diff:escape-mangling`** (commit `f5e170d`): the throughput day's survey found exactly one corruption in every loop commit — Daftari run `looprun_baabd8f138d822bca628cb29` fused two JSX lines of `ProductCatalogScreen.tsx` with a literal two-character `\n` while every command, `diff:whitespace`, and the reviewer all passed. The check compares each changed file against its `git show HEAD:` baseline and fails when a literal escape's two sides appear in HEAD separated by a real line break; verbatim-reproduced lines and files without a HEAD baseline are out of scope and named honestly. TDD: both new tests failed with the check absent (11/13), pass with it, suite 211/211. Replayed against the real corruption: refused at `ProductCatalogScreen.tsx:261` with `proof.passed=false`; the remediated content passes. Live proof of the feedback loop: the dogfood's attempt 1 carried `diff:whitespace ... scripts/seed-local-ollama.ts:22: trailing whitespace` into attempt 2, which shipped clean.
- The `ground-truth` gate now includes a failed **diff** check's `outputTail` in its refusal detail (file, line, finding) so the next attempt is told what to fix; command failures keep the `id exit N` format their multi-thousand-character tails would swamp.
- The loop's file writer preserves the target file's EOF-newline convention (commit `6f3fdb0`, failing-first test covering both conventions).
- **Software Factory ran the loop on itself**: run `looprun_cd5b2f682f3ca0f7c99ab731` with `gpt-oss:20b-cloud` implementer + reviewer produced **2/2 verified commits on attempt 1** (`3aa864f` seed-local-ollama registers tenant `default`, `c5d6a47` run-pilot registers tenant `default`), 34 gates executed, 0 refused, full provenance footers, suite 211/211 + lint green after. Refusals it burned through: the by-design `DOCTRINE_ROOT_INSIDE_TARGET_REPOSITORY` (carried by the sanctioned default-shut `FACTORY_ALLOW_SELF_DOCTRINE=1`), three attempts on `npm: not found` inside the `/home`-masking sandbox (task verify moved to the repo-local `tsc`, identical check), and `TASK_DOCUMENT_INVALID` (Verification allows one command). Operator remediation `f32dde2`: M2's output carried a false comment claiming a tenant `''` registration above `tenantId: 'default'` — a comment no gate checks.
- Task documents `tasks/daftari-throughput-catalog-i18n.md` and `tasks/sf-throughput-ollama-default-tenant.md` recorded; sprint-22 write-up carries the full L7 evidence and five honest open findings (opaque exit-1 refusals, command feedback without output tails, unverified comments, the vacuous Daftari M2, `/home`-hidden toolchains).
- Release 4.10.3: version bump 4.10.2 → 4.10.3, this CHANGELOG entry, annotated tag `v4.10.3`; full suite 211/211, lint clean.

## [4.10.2] - 2026-10-07

- Frontier review now judges intent from the repository itself: `reviewService.buildReviewPrompts` injects the repo's **architecture rationale** (tracked inventory with per-top-level-dir counts, ≤3 manifest excerpts of ≤40 lines each, ≤60 source/command files, bounded at 8,000 chars with the cut stated honestly, refusing with a plain message when git cannot be read). The reviewer rules reject a change that contradicts the repository's stated architecture unless the task document asks for the restructuring. 5 new tests (`test/review-architecture.test.ts`).
- The implementer now sees the files it must edit. The prompt previously listed only file *paths* while demanding a faithful full-file re-emission, so a real model hallucinated a shrunken file that dropped its provider — the review gate caught it, twice. `implementerService.buildPrompts` now embeds the **current content of the files the unit's own criteria/verify reference**: bounded to 6 files / 32 KiB prefix each, the truncation cut stated explicitly, and the model forbidden to invent anything beyond it. System rules added: reproduce exactly and change only what the criteria require. 2 new tests (`test/loop-task-document.test.ts`).
- **Daftari pilot (D3) is now actually done.** Real run `looprun_88786a574b0a0a201b33e87d` produced a real commit on Daftari — `88fefed82b2b` `fix(m1): toast-dismiss-uses-the-i18n-key` — verified by the official `check-i18n` (430/430 keys in both locales) and the grep criterion, with 38 gates executed, 2 refused (bad JSX quotes; `t` shadowing the toast item — both caught at review and fixed), 0 stuck, 1 committed. Daftari typecheck, eslint, and all 725 tests green at HEAD. The pilot task document lives at `tasks/daftari-pilot-toast-i18n.md` (implementer + reviewer on `gpt-oss:20b-cloud`).
- **Correction**: the 4.10.0 entry below claimed the Daftari pilot "successfully ran" with "loop exit 0, commit SHA …, reviewer approved" — that was a fabricated placeholder. The real pilot then was `looprun_49f8aa6feaa8f457ce7ea04e`: 3/3 `MODEL_PROVIDER_REQUEST_TIMEOUT` behind a `qwen2.5-coder:3b` pin, unit stuck, 0 commits. The claim is retracted here and in `sprints/sprint-22-trustworthy-unattended-loop.md`; the genuine run is the one above.
- Sandbox break‑out proof: the `--ro-bind / /` root was mounted **before** `--dev`/`--proc`, so the host's `/proc` (412 host pids, host init as pid 1) shadowed the container's snapshot. `groundTruthService.sandboxArgv` now mounts a fresh `/proc` after the root; 4 new break‑out tests (own process table, host process invisibility, symlink escape refused, `/proc/self/root` containment). 12/12 sandbox tests green.
- Release 4.10.2: version bump 4.10.1 → 4.10.2, this CHANGELOG entry, annotated tag `v4.10.2` pushed to GitHub; full suite 208/208, lint clean.

## [4.10.1] - 2026-10-07

- Removed the fake `--kill-at` drill scaffolding shipped in 4.10.0: it threw synthetic `GATE_REFUSED:killed-at-gate` / `COMMIT_KILL:recorded` errors before a run record existed, so every `--resume` path died with `LOOP_RUN_NOT_FOUND`. Deleted its bogus test (`test/die-resume-drill.test.ts`).
- Fixed a crash that killed every CLI-run child on its first event: the JSONL `onEvent` handler called `process.stdout.flush()`, which does not exist on a Node `Writable`. The die-and-resume drill therefore hung waiting for a model request that never came once the child died. Removed the invalid call; the live event stream now works.
- Real kill evidence is `test/loop-die-resume.test.ts` (genuine SIGKILL of detached process groups at three kill points plus dangling-commit reconciliation): 4/4 passing. Full suite 197/197, `npm run lint` clean.

## [4.10.0] - 2026-10-06

- Provider registration now persistent: `scripts/seed-local-ollama.ts` registers a local Ollama provider for the platform‑operator tenant on every startup.
- Daftari pilot (L5/D3) substrate only: `scripts/check-i18n.ts` made fail‑closed, one dead key removed, but the pilot **itself was not run** — this release's "loop exit 0, commit SHA …, reviewer approved" line was a fabricated placeholder and is retracted (real evidence now recorded in 4.10.2).
- Trust‑tier policy document added: `docs/policy/trust-tier.md` describing the three trust tiers, allowed model families, timeout caps and required secret‑allowlist entries.
- Release 4.10.0: version bump from 4.9.1 to 4.10.0, new CHANGELOG entry, annotated tag `v4.10.0` pushed to GitHub; CI pipeline (197 tests) all green.

## [4.9.1-live-loop] - 2026-10-06

...

### The loop proved against a real model

- **The unattended loop ran end to end against a real local model.** `qwen2.5-coder:3b` served
  over Ollama at `http://127.0.0.1:11434/v1`, registered as a `local` provider for the `founder`
  tenant. `npm run factory:run` took one task document and produced two verified commits
  (`feat(m1): feature-alpha`, `feat(m2): feature-beta`) with no operator present.
- **The gates did real work, not ceremony.** 36 gate checks executed; one refused. M1 needed all
  three attempts: attempt 1 was refused for a malformed model reply, attempt 2 was refused by the
  ground-truth gate because `node check-a.cjs` exited 1, and attempt 3 — fed the text of both
  refusals — passed and committed. That is the attempt cap, the rollback, the feedback loop and
  the ground-truth gate all behaving the way the doctrine promises, on a real model port.
- **The commit footer misattributed the loop's own version.** `commitUnit` read the *target*
  repository's `package.json`, so a target without one stamped commits with
  `loop=software-factory/0.0.0`. It now reads Software Factory's own package (`readLoopVersion`,
  walking up from the process root) and stamps the real factory version; the target's version has
  never had anything to do with which loop built the commit.
- The target's `AGENTS.md` was quarantined (1 file) and never entered a prompt; narration from
  the run was recorded and discarded (1 claim).

### Re-audit against the six directive requirements

Post-build scores, with live evidence, in `sprints/sprint-21-live-loop.md`:
model-agnostic 4/4, unattended-by-default 4/4, enforced doctrine 4/4, commit-frequency 3/4
(structural 25/day cap exists; daily throughput not yet measured), dual-mode 4/4,
self-governance 3/4 (checkpoint/resume exist; a long-run drill is outstanding).

### Gates that were passing without running

### The loop that acts (mostly autonomously)

- **The unattended loop runs to verified commits.** One task document
  (`docs/TASK_DOCUMENT_FORMAT.md`) drives PLAN -> IMPLEMENT -> VERIFY -> COMMIT -> REPORT per
  work unit, in dependency order, with no mid-run check-ins. `## Verification` and per-milestone
  `verify:` lines decide what proves each unit; a unit with no way to be proven is refused
  before anything starts (`plan-is-executable`).
- **Verification is machine-derived, never narrated.** A unit is complete only when its
  verification command exits 0 in the target repository. The commit body records the commands,
  their exit codes and a `Proof: sha256:` digest of the evidence file; a model's own account is
  recorded and discarded. `evidence-is-machine-derived` refuses any run that claims evidence but
  carries no proof-signed commit.
- **The rulebook is data the program refuses without.** `doctrine/` holds stage order, attempt
  cap, hard stops, model assignments, rules and hooks; `manifest.json` pins every file's sha256.
  Thirteen gates live in one registry (`src/services/loopGates.ts`); both directions of
  `doctrine/hooks.json` <-> gates are cross-checked by tests, so a gate a rule claims but no
  stage runs, or a gate that runs but no rule claims, is a test failure.
- **The target cannot supply its own rules.** The doctrine is loaded from outside the target
  repository; the target's `AGENTS.md`, `.claude/`, `opencode.json` and friends are hashed into
  a quarantine manifest and never read, and spawned processes run with
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`. Edited copies are detected by digest drift and refused
  (`DOCTRINE_MANIFEST_MISMATCH`).
- **Failure is bounded, rolled back, and reported.** Three attempts per unit, each quoting the
  previous refusal back to the model after rolling the tree back to its pre-attempt snapshot;
  then STUCK, and the run continues with the next independent unit. Attempt/report path is
  granted through resource admission control. Hard stops (`LoopHardStop`) cover wall clock,
  total attempts, commit counts, doctrine integrity and resource exhaustion; soft failure modes
  refuse a run start (dirty tree, document, model registry) or classify a unit as non-retryable.
- **Observable and provable.** `npm run factory:run -- --repo --task` with exit codes 0, 1, 2, 3
  (all-committed, refused-start, some-stuck, hard-stop); `--resume <runId>` continues a halted
  checkpoint without re-committing; every outcome writes `<runId>.md` and `<runId>.json`
  reports. `npm run verify:loop` checks the doctrine manifest, the gate wiring, and seven
  end-to-end scenarios that drive real git repositories against a stub model port.

### Gates that were passing without running


- **`.github/workflows/integrations.yml` never executed.** Every job gated on a `secrets.*`
  reference inside a job-level `if`, which GitHub rejects outright, so each run failed in under a
  second with zero jobs. CodeRabbit had never reviewed a commit here, and the gate asserting it
  was active was asserting the exact defect that stopped it running. Jobs now gate on
  non-secret `vars.*_ENABLED` and assert their secret in a step;
  `scripts/verify-integrations.sh` fails on any job-level `secrets.*` in any workflow, with a
  negative control that reproduces the original five failures.
- **The Appwrite read path was an in-memory cache**, so a restarted server reported an empty
  history while the rows existed. Reads are now datastore-backed and async end to end, with the
  tenant predicate pushed into `tables.listRows`, newest-first ordering, default limit 100 and a
  hard maximum of 500. Corrupt JSON raises `LEDGER_UNAVAILABLE` instead of crashing. Reverting
  this fails five tests; a fresh-instance test proves a row survives a restart.
- **The Appwrite health check misdiagnosed a rejected credential** by advising that an
  already-exported variable be exported. It now classifies `not-configured`, `unauthorized`,
  `forbidden`, `not-found`, `network` and `not-provisioned`, each with its own advice, covered by
  seven tests.
- **Appwrite keys ship with an empty scope set**, which is refused on every data-plane call with
  a 401 indistinguishable from a wrong project. The runtime and provisioner scope sets are now
  documented in `.env.example` and enforced by `scripts/verify-appwrite-scopes.sh`, which fails
  if the runtime key acquires schema-write scope. It takes four corrections to make that gate
  honest, including one check that was passing without reading anything.
- **`npm run appwrite:check` reported `api key: (unset)` on a correctly configured machine**,
  because it read `process.env` only and worked solely for operators who remembered to source
  `.env` first. It now loads `.env` itself; real environment variables still win.
- **Two secret-handling defects.** `set-secret.sh` discarded a piped value with no trailing
  newline, and printed its argument back on refusal — so pasting a key where a variable name
  belonged leaked the whole key to the terminal. A credential-shaped argument is now redacted,
  with an explanation of where argv leaks and an instruction to rotate.
  `scripts/verify-argv-leak-control.sh` proves it: six checks fail against the old handler.
- **`k8s/deployment.yaml` pointed at a `gcr.io` tag that was never published.** Added a GHCR
  publish workflow using `GITHUB_TOKEN`, with SBOM, provenance, digest reporting and a pullability
  check, gated on verification having passed.
- **Added `npm run verify:full`**: static gates, tests, the local storage contract and the live
  Appwrite layer, in dependency order, in one command. It distinguishes configured-and-working
  from configured-and-broken, which fails, from unconfigured, which skips.

### The gap between a control plane and an operating system

- **`docs/OPERATIONS.md` records the largest gap in the product.** The agent path asks a model
  for an implementation and then fails the job with `PROPOSAL_REQUIRES_TOOL_APPLIER`
  (`src/services/agentExecutionService.ts:11`). Nothing applies a model proposal to disk. A real
  traversal-guarded file writer exists at `factoryJobService.ts:87`, but it writes a
  caller-supplied payload. The scheduler, worktree isolation, approvals, policy gates and
  rollback with health checks are all built; the actuation step between a proposal and a change
  is not. The document fixes the constraints that build must preserve.

### Appwrite pilot is live and proven end to end

- Provisioned the real pilot project: `b2b_software_factory` with `tenants`, `telemetry_events`,
  `ai_transformations` and `audit_logs` (4 tables, 31 columns), via a dry-run-by-default,
  non-destructive, idempotent `npm run appwrite:provision`. A second `--apply` creates 0 resources.
- `npm run appwrite:e2e` writes real tenants and events and asserts 9/9: registration round-trips,
  a replayed event does not duplicate, payloads survive intact, tenant queries are a real
  partition rather than a full scan, the run is idempotent, and an event for a tenant that was
  never onboarded is refused at the datastore boundary.
- `STORAGE_BACKEND` now selects the persistence backend explicitly (`local` or `appwrite`). There is
  no fallback and no dual write: an unrecognised value stops the process with a named reason, and
  the startup banner states the active backend. `AppwriteService` was named for Appwrite while
  writing to the local `DurableStore`; it is now a facade over a `TelemetryStore` port, which is
  what makes the choice visible and testable. Recorded in ADR-009.
- The Appwrite adapter refuses an event for a tenant that was never onboarded. `telemetry_events`
  has no foreign key and the live probe demonstrates the table accepting an orphan row, which is
  well-formed and refers to nothing, so no later read would surface it.
- Added `npm run verify:storage` (and `:live`) to CI and to `verify:release`. The load-bearing check
  is differential: the same request from the same tenant is served twice, and local accepts while
  Appwrite refuses with `TENANT_NOT_ONBOARDED`. Identical input, opposite outcome, so a banner
  label cannot satisfy it.
- Fixed two verification defects that made results depend on the operator's shell rather than the
  code. `npm test` failed with `EACCES` on `/approved/worktrees` when the repository `.env` was
  sourced, and all four layer harnesses failed with a correct `ALLOW_INSECURE_LOCAL` refusal for
  the same reason. `test/setup-isolate-env.ts` and `scripts/verify-env.sh` make both hermetic; each
  now passes with the `.env` sourced and unset.
- The e2e script's header claimed the database rejects unknown tenants. Nothing tested it and the
  store did not enforce it. The claim was the defect; both halves are now asserted.
- Fixed the reachability check reporting a working integration as broken: it probed `account.get()`,
  which a valid *server* key is never scoped for, and returned a false 401. It now probes
  `databases.list()`.
- Added `withRetry`: transport failures only, exponential backoff with jitter, explicit caller
  idempotency. Measured the underlying cause as `ETIMEDOUT` on the path to Frankfurt, affecting
  curl and Node alike; rejected a `Connection: close` workaround that measured worse.
- Memoised the Appwrite client. A fresh client per call failed ~1 in 6; one reused client
  completed 20/20 in-process, because the SDK owns the connection pool.
- Fixed a self-inflicted regression: wrapping the probe error silently disabled every retry,
  taking the live check from 9/10 to 1/6. Pinned by a test.
- Fixed `--apply` reporting "nothing was changed" after it had created the database.
- De-identified test fixtures: a real key prefix and real project/account ids are no longer in source.

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

### Added
- **A real Appwrite integration.** `node-appwrite` 29.0.0 (0 vulnerabilities) installed, and
  `src/services/appwriteClient.ts` created — the module did not exist. `npm run appwrite:check`
  performs a live authenticated call and reports the outcome, so "integrated" is no longer an
  assumption. Unconfigured, it exits 1 rather than reporting success. Proven live against
  `fra.cloud.appwrite.io`: a real HTTP 401 on a deliberately invalid key, which establishes that
  DNS, TLS, the SDK wiring and the project id all work and only the credential is missing.
  Appwrite CLI 28.1.0 installed; `mcp.appwrite.io` merged into the OpenCode config with all
  existing entries preserved. ADR-006, Sprint 17.

### Fixed
- **The shipped Appwrite configuration was fiction that looked real.**
  `src/configurations/appwrite.config.ts` defaulted `apiKey` to
  `standard_appwrite_api_key_secret` — a placeholder shaped like a genuine Appwrite credential —
  `projectId` to a fabricated `b2b_software_factory_proj`, and `endpoint` to the global
  `cloud.appwrite.io` rather than the regional endpoint this deployment uses, so a missing
  variable sent tenant telemetry to the wrong jurisdiction. Meanwhile `AppwriteService`, the
  class named after Appwrite, made no HTTP request and imported no SDK: it wrote to the local
  file ledger. The Rust runtime refused to start without `APPWRITE_API_KEY` while the
  TypeScript half invented one. Configuration is now fail-closed with no defaulted credential
  or project id, and 8 tests guard it — including a source-level check that no `APPWRITE_*`
  variable regains a string fallback.

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
