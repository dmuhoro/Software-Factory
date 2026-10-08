# Changelog - Software Factory Multi-Tenant B2B SaaS Platform

All notable architectural and code modifications are documented here.

## [Unreleased] - 2026-10-08

### Sprint 25 — borrowed leverage (in progress)

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
- Full suite: **257/257** passing (230 at sprint-24 close + 27 new); `tsc --noEmit` clean; build clean.

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


### 4.11.0 - 2026-10-07
```

Wait, there's already a `### 4.11.0` line right after Unreleased. Let me re-read the structure. The CHANGELOG had:
```
## [Unreleased] - 2026-10-07

### 4.11.0 - 2026-10-07
```
That's odd — Unreleased contains 4.11.0? My edit replaced the Unreleased header + 4.11.0 header with new content ending in `### 4.11.0 - 2026-10-07`. Good, preserved.

Now commit docs.</think>

<｜DSML｜ calls>
<｜DSML｜ invoke name="bash">
<｜DSML｜ parameter name="command" string="true">cd /home/daniel-muhoro/workspace/projects/Software-Factory && git add sprints/sprint-24-remote-control-plane.md CHANGELOG.md && git commit -q -m "docs(sprint): record the landed control plane and goal-intake evidence

Adds an evidence section to the sprint-24 record naming the command behind every
claim (the writer-lock probe, the 226/226 suite, the HTTP 401/202/SSE run, and
the goal round-trip), and a changelog entry for the three commits. States
plainly that L6/L7/L8 are not started and that the live deploy and sustained
throughput remain operator-blocked." && git log --oneline -6

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

### 4.10.3 - 2026-10-07

- **New ground-truth check `diff:escape-mangling`** (commit `f5e170d`): the throughput day's survey found exactly one corruption in every loop commit — Daftari run `looprun_baabd8f138d822bca628cb29` fused two JSX lines of `ProductCatalogScreen.tsx` with a literal two-character `\n` while every command, `diff:whitespace`, and the reviewer all passed. The check compares each changed file against its `git show HEAD:` baseline and fails when a literal escape's two sides appear in HEAD separated by a real line break; verbatim-reproduced lines and files without a HEAD baseline are out of scope and named honestly. TDD: both new tests failed with the check absent (11/13), pass with it, suite 211/211. Replayed against the real corruption: refused at `ProductCatalogScreen.tsx:261` with `proof.passed=false`; the remediated content passes. Live proof of the feedback loop: the dogfood's attempt 1 carried `diff:whitespace ... scripts/seed-local-ollama.ts:22: trailing whitespace` into attempt 2, which shipped clean.
- The `ground-truth` gate now includes a failed **diff** check's `outputTail` in its refusal detail (file, line, finding) so the next attempt is told what to fix; command failures keep the `id exit N` format their multi-thousand-character tails would swamp.
- The loop's file writer preserves the target file's EOF-newline convention (commit `6f3fdb0`, failing-first test covering both conventions).
- **Software Factory ran the loop on itself**: run `looprun_cd5b2f682f3ca0f7c99ab731` with `gpt-oss:20b-cloud` implementer + reviewer produced **2/2 verified commits on attempt 1** (`3aa864f` seed-local-ollama registers tenant `default`, `c5d6a47` run-pilot registers tenant `default`), 34 gates executed, 0 refused, full provenance footers, suite 211/211 + lint green after. Refusals it burned through: the by-design `DOCTRINE_ROOT_INSIDE_TARGET_REPOSITORY` (carried by the sanctioned default-shut `FACTORY_ALLOW_SELF_DOCTRINE=1`), three attempts on `npm: not found` inside the `/home`-masking sandbox (task verify moved to the repo-local `tsc`, identical check), and `TASK_DOCUMENT_INVALID` (Verification allows one command). Operator remediation `f32dde2`: M2's output carried a false comment claiming a tenant `''` registration above `tenantId: 'default'` — a comment no gate checks.
- Task documents `tasks/daftari-throughput-catalog-i18n.md` and `tasks/sf-throughput-ollama-default-tenant.md` recorded; sprint-22 write-up carries the full L7 evidence and five honest open findings (opaque exit-1 refusals, command feedback without output tails, unverified comments, the vacuous Daftari M2, `/home`-hidden toolchains).
- Release 4.10.3: version bump 4.10.2 → 4.10.3, this CHANGELOG entry, annotated tag `v4.10.3`; full suite 211/211, lint clean.

### 4.10.2 - 2026-10-07

- Frontier review now judges intent from the repository itself: `reviewService.buildReviewPrompts` injects the repo's **architecture rationale** (tracked inventory with per-top-level-dir counts, ≤3 manifest excerpts of ≤40 lines each, ≤60 source/command files, bounded at 8,000 chars with the cut stated honestly, refusing with a plain message when git cannot be read). The reviewer rules reject a change that contradicts the repository's stated architecture unless the task document asks for the restructuring. 5 new tests (`test/review-architecture.test.ts`).
- The implementer now sees the files it must edit. The prompt previously listed only file *paths* while demanding a faithful full-file re-emission, so a real model hallucinated a shrunken file that dropped its provider — the review gate caught it, twice. `implementerService.buildPrompts` now embeds the **current content of the files the unit's own criteria/verify reference**: bounded to 6 files / 32 KiB prefix each, the truncation cut stated explicitly, and the model forbidden to invent anything beyond it. System rules added: reproduce exactly and change only what the criteria require. 2 new tests (`test/loop-task-document.test.ts`).
- **Daftari pilot (D3) is now actually done.** Real run `looprun_88786a574b0a0a201b33e87d` produced a real commit on Daftari — `88fefed82b2b` `fix(m1): toast-dismiss-uses-the-i18n-key` — verified by the official `check-i18n` (430/430 keys in both locales) and the grep criterion, with 38 gates executed, 2 refused (bad JSX quotes; `t` shadowing the toast item — both caught at review and fixed), 0 stuck, 1 committed. Daftari typecheck, eslint, and all 725 tests green at HEAD. The pilot task document lives at `tasks/daftari-pilot-toast-i18n.md` (implementer + reviewer on `gpt-oss:20b-cloud`).
- **Correction**: the 4.10.0 entry below claimed the Daftari pilot "successfully ran" with "loop exit 0, commit SHA …, reviewer approved" — that was a fabricated placeholder. The real pilot then was `looprun_49f8aa6feaa8f457ce7ea04e`: 3/3 `MODEL_PROVIDER_REQUEST_TIMEOUT` behind a `qwen2.5-coder:3b` pin, unit stuck, 0 commits. The claim is retracted here and in `sprints/sprint-22-trustworthy-unattended-loop.md`; the genuine run is the one above.
- Sandbox break‑out proof: the `--ro-bind / /` root was mounted **before** `--dev`/`--proc`, so the host's `/proc` (412 host pids, host init as pid 1) shadowed the container's snapshot. `groundTruthService.sandboxArgv` now mounts a fresh `/proc` after the root; 4 new break‑out tests (own process table, host process invisibility, symlink escape refused, `/proc/self/root` containment). 12/12 sandbox tests green.
- Release 4.10.2: version bump 4.10.1 → 4.10.2, this CHANGELOG entry, annotated tag `v4.10.2` pushed to GitHub; full suite 208/208, lint clean.

### 4.10.1 - 2026-10-07

- Removed the fake `--kill-at` drill scaffolding shipped in 4.10.0: it threw synthetic `GATE_REFUSED:killed-at-gate` / `COMMIT_KILL:recorded` errors before a run record existed, so every `--resume` path died with `LOOP_RUN_NOT_FOUND`. Deleted its bogus test (`test/die-resume-drill.test.ts`).
- Fixed a crash that killed every CLI-run child on its first event: the JSONL `onEvent` handler called `process.stdout.flush()`, which does not exist on a Node `Writable`. The die-and-resume drill therefore hung waiting for a model request that never came once the child died. Removed the invalid call; the live event stream now works.
- Real kill evidence is `test/loop-die-resume.test.ts` (genuine SIGKILL of detached process groups at three kill points plus dangling-commit reconciliation): 4/4 passing. Full suite 197/197, `npm run lint` clean.

### 4.10.0 - 2026-10-06

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
