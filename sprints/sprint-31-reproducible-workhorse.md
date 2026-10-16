# Sprint 31 — The Reproducible Workhorse

**Status:** WP-0 governance (v4.15.x), WP-1 reproducibility (v4.15.0), WP-2 truthful docs (v4.15.1), WP-3 dead-code gate (v4.15.2 — shipped red, corrected v4.15.3), WP-4 executor-host artifacts, WP-5 phone surface and WP-6 skills bridge landed and released together as **v4.15.4**; WP-7 blocked on model access and recorded as such in **v4.15.5** · **Opened:** 2026-10-15 · **Closed:** 2026-10-16

**Thesis.** Sprint 30 gave the factory a face and a floor: a declarative capability manifest, a
skills registry, a fleet read surface, a fail-closed deploy preflight, and an evidence page rendered
from the manifest. Sprint 31 makes that real in the only sense that matters: **a fresh clone must run
green anywhere, the documents must stop overclaiming, and the factory must run unattended on an
operator-owned Linux host reachable from a phone** — with the external skills it adopts vendored,
hash-pinned, and provably worth their place. Every claim the docs make must be reproducible by a named
command on a machine that is not the author's (Constitution Part Two; SOP rule 4).

Follows `docs/CONSTITUTION.md`, the ADRs in `docs/adr/`, `CONTRIBUTING.md`, and the cross-repo SOP.

---

## The finding that scoped this sprint

An independent audit ran from a clean clone and found the gap this repository's own discipline exists
to prevent: **"457 / 457" was true on the author's machine and false on a fresh one.**

- **The suite depends on a tool the CI never installs.** Sandbox tests drive the real `runCommand`
  with `bwrapBinary: 'bwrap'` (`test/loop-sandbox.test.ts:30,33`). `bubblewrap` is present on the
  development host (`/usr/bin/bwrap`) but `.github/workflows/verify.yml:86` runs `npm test` on
  `ubuntu-latest` and installs nothing (`:29`). A clean clone and CI therefore run those tests against
  a missing binary. A gate that is green only where the author sits is not a gate.
- **A doctrine test asserts on untracked local directories.** `test/loop-doctrine.test.ts:115`
  ("a repository cannot supply the rules it is judged by") stages `process.cwd()` and asserts
  `quarantine.length > 0` (`:127`). Instruction files are discovered from `TARGET_INSTRUCTION_FILES`
  and `TARGET_INSTRUCTION_DIRS` (`doctrineIsolationService.ts:58,70`), which include `.claude` and
  `.agents`. Those directories exist **only as gitignored local state** (`.gitignore:19-20`); a fresh
  clone has none, so the assertion fails. `AGENTS.md` does not exist anywhere (not merely untracked).
- **The docs drifted.** `README.md:97` says "76 tests" (the suite is 457); `:333` calls a
  `gpt-oss:20b-cloud` Ollama endpoint a "real local model"; `:339` states "≈66 units/hour", an
  extrapolation from four units; the "Remote control plane" section appears twice (`:368`, `:388`).
- **The `skills` registry is a shell.** It has one consumer (`factory.routes.ts:81`), one skill
  (`skills/repo-hygiene.skill.md`), and the loop reads no skill. No Pocock or Ondrej content is
  present anywhere in the repository or the local skill directories.
- **Unwired code and no dead-code gate.** `WebhookService` / `verifyWebhookSignature`
  (`webhookService.ts:141,165`), `assertStageGates` (`loopGates.ts:369`),
  `BUILT_IN_REPOSITORY_CONTEXTS` (`contextIndexService.ts:112`), `prepareDirectory` / `tempRoot`
  (`pathGuard.ts:118,138`) have no production caller, and nothing (`knip`) notices.
- **Measured at HEAD: the pipeline is red.** The `verify` workflow on `main` (run `38630649578`,
  v4.14.4) reports `# tests 457 · # pass 413 · # fail 44`; the job aborts at `npm test`, so every
  later gate (Layers 1–4, storage, secrets, release records, docs, knowledge base) has not run on
  `main`. A separate job fails its own check: the Kubernetes deployment still pins `runtime:v4.8.0`
  while the release is v4.14.4. `v4.14.2`, `v4.14.3` and `v4.14.4` were all tagged on this red
  pipeline. This is WP-1's first job, and it is the strongest single piece of evidence in the audit:
  the local green was real, and it was local only.

The corrected scope is **reproducibility first**, because every other goal — the VPS, the phone, the
skills — is worthless if a clean clone is red. Then truthful docs, then a dead-code gate, then the
operator-owned executor host and the phone surface, and finally the vendored skills measured against a
benchmark so adoption is a decision from data, not taste.

## Work packages

Each WP is bounded to this repository, carries a failing-first test (or, for governance, an artifact),
and is independently releasable. Order is a dependency order: reproduce, then tell the truth, then
delete, then host, then face, then skills, then measure.

| WP | Objective | Proof | Status |
|---|---|---|---|
| **WP-0** | Governance: this sprint file + ADR-013 + ADR-014 | `npm run verify:docs` green; no production code | **done** |
| WP-1 | Reproducibility: a fresh clone runs green anywhere (hermetic tests, a loud sandbox preflight, `bubblewrap` in CI, a tracked contributor `AGENTS.md`) | `verify:fresh-clone` red on the pre-fix tree, green after | **done** |
| WP-2 | Truthful docs: README counts and the capability list generated from the manifest; stale claims removed; the Manus audit archived | no README figure that a command does not reproduce | **done** |
| WP-3 | Dead-code gate: unreferenced exports deleted or wired per finding | `npm run knip` → exit 0, 0 findings, 0 hints, enforced in `verify`, `verify:full`, the fresh-clone gate and CI | **done — v4.15.3** (v4.15.2 shipped the claim without the config) |
| WP-4 | Executor host: an operator-owned Linux host, unprivileged runner, `bubblewrap`, hardened `systemd`, tailnet-only bind (implements ADR-014) | reboot-mid-run drill passes on a real host | **repo-side done** — provisioning script, unit, `verify:host` and the bind policy landed; the host drill is blocked (owner: operator) |
| WP-5 | Phone surface: mobile-first Loop tab (goal/issue submit, run list, live events, two-phase cancel) + signed outbound notifications via `WebhookService` | delivery test + the operator's recorded on-device check | **repo-side done** — UI calls the issue/cancel routes, `WebhookService` has a production caller and a signed-delivery test; on-device check blocked (owner: operator) |
| WP-6 | Skills bridge: vendor a starter set with provenance + sha256, refuse unpinned/modified, wire by role, default OFF (implements ADR-013) | an unpinned skill refuses; a modified one refuses | **repo-side done** — the pin gate, fenced seam and default-OFF role wiring landed and are proven; adopting external Pocock/Ondrej content is blocked by source coordinates, not by the third party (owner: engineering — corrected in Sprint 33, WP-0) |
| WP-7 | Measurement: 12–15 canned tasks across ≥3 repos, with and without skills | a table of first-attempt rate, STUCK rate, wall time, cost per verified commit | **blocked — no model reachable** (hosted: owner operator; the local Ollama daemon is not running in the agent shell). No harness was built, because a 12–15-task scaffold that cannot be run would be capability theater, not evidence. |

### Scope limits (hard — do not implement in this sprint)

- **No new egress.** Every model call stays behind the single egress door (ADR-011). No vendor SDK
  outside `modelEgress.ts`, and **no `research-and-web`-style skill** that would route through a
  third-party gateway (it would bypass the one door).
- **No second runtime.** The Rust service (`software_factory/`) stays as-is. Two live runtimes without
  one owner is the drift the Constitution forbids.
- **No public ingress.** The executor API binds to `localhost` and the tailnet only (ADR-014). No
  published port, no auto-deploy, no self-modifying schema.
- **Skills never relax a gate.** A skill is advisory text (ADR-013). It cannot alter a rule, a hook, a
  model assignment, or a gate's verdict.
- **No horizontal-scale claim.** The ledger is single-writer (NC-2); one executor host per operator.
  The phone surface must not imply multi-replica writes the ledger cannot support.

### Evidence plan (per WP)

The repository's discipline, with two corrections this sprint earned:

1. **A failing-first test**, shown to fail without its fix, the negative result recorded in the WP
   write-up.
2. **"Prove the proof"** — every new gate is *observed rejecting* the thing it rejects, and that
   negative result is recorded (SOP rule 4). A gate that has never refused is untested.
3. **Hermetic by default** — a test may not depend on untracked local state. Where a test must prove a
   property of the real repository, it asserts on tracked evidence, not on `process.cwd()` contents.
4. **The error contract holds** — any new boundary error code is registered in `src/utils/apiError.ts`
   and covered by `test/l3-error-contract.test.ts`, or the route silently degrades to
   `INTERNAL_ERROR` (the v4.14.2 lapse).
5. **The full suite runs foreground** with an explicit large timeout, and never two suites at once. A
   backgrounded suite is killed when the shell times out; a "detached" suite is not evidence.
6. **One version per WP:** a feature commit, then a separate release commit (`package.json` +
   `package-lock.json` + `CHANGELOG.md` + this sprint file), annotated tag `v4.15.x`, push `main` +
   tag, and verify remote `main == HEAD == tag`.

## Named blockers (not worked around)

- **The hosted-model decision (owner: operator).** A cloud box cannot usefully run a 14B model; the
  executor host needs an allowlisted secret ref, a permitted host, and a spend cap (Sprint 28 WP-5).
  Until then, WP-7 runs local and labels what it did not measure.
- **VPS provisioning and Tailscale (owner: operator).** A host, `bubblewrap`, a scoped deploy key per
  repository, and the phone on the tailnet. WP-4 supplies the provisioning script; the operator runs
  it. Tailscale is already on the phone.
- **Skill sources and licences (owner: operator + engineering).** WP-6's bridge is landed and proven
  against the in-repo skill; vendoring the Pocock/Ondrej content still needs each source's exact files,
  commits, licences and sha256 pins as a reviewed decision, and WP-7 data before adoption (ADR-013 §7).
- **`bubblewrap` in the shipped container image (owner: operator).** The runtime image installs none;
  sandboxed execution fails closed there (ADR-010). WP-4's host installs it; the image is separate.

## What this means for the ecosystem

Sprint 29 asked *"can the factory feel?"*; Sprint 30 asked *"can a person point at it, and will it
stand up?"* Sprint 31 asks *"can anyone else run it, is it telling the truth about itself, and can its
owner steer it from a phone while it works on a server they control?"* When it lands: a clean clone
runs green in CI; the README's numbers are generated, not typed; unreferenced code is caught by a gate;
the loop runs sandboxed on an operator-owned host reachable only over a private network; a phone can
submit work, watch it, and cancel it in two phases; adopted skills are vendored, hash-pinned, and
default-off; and a benchmark states whether skills move the first-attempt rate. What remains
operator-blocked — the hosted model, the `bubblewrap`-in-image gap, and any live use of an external
runtime — stays named with its owner, as a decision rather than an engineering backlog.

## WP-0 — Governance (this change, no production code)

- This sprint file.
- `docs/adr/ADR-013-skills-are-advisory-vendored-and-hash-pinned.md` (Proposed).
- `docs/adr/ADR-014-executor-host-operator-owned-private.md` (Proposed).

Both ADRs are **Proposed**, not Accepted, deliberately: the Constitution (Scope rule 2) requires the
code that satisfies a decision to land with it. WP-6 lands ADR-013's code and flips it to Accepted in
the same change; WP-4 lands ADR-014's.

**Evidence:** `npm run verify:docs` green. No production code touched.

**Stopping point:** WP-1 does not begin until the founder approves both ADRs. The stopping point exists
because ADR-014 fixes a trust boundary (who may run the loop, where secrets live) and ADR-013 fixes a
supply-chain stance (what an adopted skill is allowed to be), and both are decisions the founder owns,
not defaults an implementation should assume.

**Sign-off:** ADR-013 and ADR-014 were approved 2026-10-15, so WP-1 may begin. Both ADRs were
**Proposed** in status until the code that satisfies them landed (WP-6 and WP-4); both are now
**Accepted**, per the Constitution's scope rule.

## WP-1 — Reproducibility (done, v4.15.0)

A fresh clone runs the full suite green with no undeclared local state. Landed in layers, each its
own commit on `sprint-31/wp-1-reproducibility`, merged as PR #6:

- **Release records agree (L0).** The 41 changelog headings under `[Unreleased]` were promoted to
  `## [x.y.z] - <tag date>`; `software_factory/Cargo.toml` and `Cargo.lock` were re-synced from 4.9.1
  to the live version. The release gate had been red since 4.9.1 and CI never reached it because it
  aborted at `npm test`. `verify-release.sh --pre-release` went 7/4 → **11/11**.
- **`bubblewrap` in CI (L1).** The `typescript` job installs bubblewrap and proves it can unshare
  before the suite; the proof is the gate.
- **A loud sandbox preflight (L2).** `src/services/sandboxPreflightService.ts` (new) resolves the
  binary and runs a real probe; `ExecutionLoopService.run()` refuses before any work when the sandbox
  cannot run. Three boundary codes registered in `src/utils/apiError.ts`. `test/sandbox-preflight.test.ts`
  (new, 9 tests). Failing-first: 8/9 with the preflight removed from `run()`.
- **Hermetic doctrine test + tracked contributor file (L3).** `AGENTS.md` is tracked at the root and
  the self-stage test asserts on it by name — no more dependence on a gitignored `.claude/`/`.agents/`.
  Failing-first: absent `AGENTS.md` → 9/10.
- **`verify:fresh-clone` (L4).** `scripts/verify-fresh-clone.sh` (new) clones the committed tree,
  `npm ci`, proves the sandbox, typechecks and runs the suite; a CI job runs it. Green end to end.
- **The deployment manifest names the release (L5).** `k8s/deployment.yaml` moved off `runtime:v4.8.0`
  to the live tag; `verify-k8s.py` 58/58.
- **The README moves with the product (L6).** Verifying section names `verify:docs` and
  `verify:fresh-clone`, states the bubblewrap dependency, and corrects the manifest count.
- **CI unprivileged-userns fix (L7a).** On `ubuntu-latest` (24.04) the sandbox probe failed with
  `loopback: Failed RTM_NEWADDR: Operation not permitted`; the job lifts
  `kernel.apparmor_restrict_unprivileged_userns` on the ephemeral runner (both sandbox jobs).
- **The sandbox finds node wherever the runtime is installed (L7b).** Six tests passed locally and
  failed in CI with `SANDBOX_TOOLCHAIN_HIDDEN`: the resolver assumed `/usr/bin/node`, but CI installs
  node under `/opt/hostedtoolcache` and the `node:22-slim` runtime image puts it under `/usr/local/bin`.
  `resolveExecutable` now falls back to `process.execPath` when the sandbox can see it, and
  `sandboxVisiblePath` includes `/usr/local/bin` and that runtime directory. Masked roots are declared
  once (`SANDBOX_MASKED_ROOTS`, `groundTruthService.ts`) and shared with the mount list.

**New files:** `AGENTS.md`, `scripts/verify-fresh-clone.sh`, `src/services/sandboxPreflightService.ts`,
`test/sandbox-preflight.test.ts`.

**Evidence:** `npm test` **468/468**; `verify:fresh-clone` green in a clean clone; `verify-release.sh
--pre-release` **11/11**; `verify:docs` **6/6**; `verify-k8s.py` **58/58**; `npx tsc --noEmit` clean.
CI: `typescript` (7m52s), `fresh clone` (6m21s), `rust`, `kubernetes manifests`, `workflow definitions`
all pass on the PR. Failing-first recorded for the preflight wiring, the doctrine self-stage, and the
toolchain resolver.

## WP-2 — Truthful docs (done, v4.15.1)

The README's capability list is now generated from `src/services/capabilityManifest.ts` — the same
list the API and the evidence page read — so it cannot describe a capability the code does not, and
the figures that had drifted are gone.

- **Generated capability block.** `scripts/render-readme.ts` (new) renders the marked block in
  `README.md` between `<!-- readme-capabilities:start -->` and `<!-- readme-capabilities:end -->`;
  `npm run render:readme -- --check` fails on drift, and it runs inside `verify:docs`.
- **Generated codebase index.** `scripts/render-codebase-index.ts` (new) renders
  `docs/audit/CODEBASE-INDEX.md` from `git ls-files`; `--check` fails on drift, and it also runs inside
  `verify:docs`.
- **The duplicate "Remote control plane" section is removed** — the first copy had lost its code and
  was rendering as empty bullets.
- **Model locality corrected.** The recorded runs used a model served by a local Ollama daemon
  (`gpt-oss:20b-cloud`); the `-cloud` path forwards to a remote host, so the egress guard observes
  loopback and not the model's true location — the hosted path is therefore declared `blocked`.
- **Extrapolated throughput removed**; only the runs' own measurements remain.
- **The Manus audit archived** at `docs/archive/DEEP_READINESS_AUDIT.md` with a superseded banner and a
  link from the README's contracts list.
- **The README is now a gated live document** in `scripts/verify-docs.sh`, so every `npm run` command
  it instructs must resolve to a real script.

**New files:** `scripts/render-readme.ts`, `scripts/render-codebase-index.ts`,
`test/readme-truth.test.ts`, `docs/audit/CODEBASE-INDEX.md`,
`docs/archive/DEEP_READINESS_AUDIT.md` (moved from the repository root).

**Evidence:** `verify:docs` **6/6** (both `--check`s green); `npx tsc --noEmit` clean;
`test/readme-truth.test.ts` **4/4**, failing-first recorded — a drifted README block fails 1 test, and a
stale index exits 1; both green when restored.

## WP-3 — Dead-code gate (done, v4.15.3)

`knip` runs in CI and in every local verification chain. Each unreferenced export in the finding
above was deleted or un-exported at its declaration.

The first attempt at this WP is itself the sprint's strongest cautionary example, so it is recorded
rather than rewritten:

- **v4.15.2 shipped a claim the repository could not reproduce.** Its release message stated
  `knip.json (new)`, `knip exit 0 with config`, and `WebhookService deleted`. At that commit
  `git cat-file -e HEAD:knip.json` fails — **no config existed**, no npm script ran knip, the run
  therefore used knip's unbounded defaults, and 58 findings remained. `WebhookService` was still
  tracked. This is precisely the defect the Constitution's "no fabricated claims" rule names, and it
  reached a tag.
- **v4.15.2 was also red.** The release bumped `package.json`, `Cargo.toml`, the k8s image tag and the
  changelog but not `package-lock.json`, so `test/l6-dependency-policy.test.ts` NC-3 failed
  (`4.15.1 !== 4.15.2`); `verify:docs` failed on a stale `docs/audit/CODEBASE-INDEX.md`; and the dead-code
  sweep had deleted `scripts/durable-writer-probe.ts`, which `test/durable-store-writer-lock.test.ts`
  spawns as a real second process, breaking the only cross-process proof of the ledger's single-writer
  lock. **472 tests, 3 failing** — on a tag.
- **v4.15.3 is the correction.** The probe is restored (it is an entry point a test reaches by path, not
  dead code), the lockfile is regenerated, the codebase index is re-rendered, and the findings are
  resolved for real: **15 declarations deleted outright**, **107 exports un-exported** to file-local
  declarations. `tsc --noEmit` passing after the sweep is the evidence that nothing outside imported
  them — a symbol another file reaches through the module boundary stops compiling the moment `export`
  goes away.
- **The gate is enforced at four points**, so it cannot quietly stop running again: `npm run verify`,
  `verify-full.sh` Layer 1, `scripts/verify-fresh-clone.sh` (a clean clone carries no dead code either),
  and the CI `typescript` job between typecheck and the suite, where a bad sweep fails next to the sweep
  rather than nine steps later.

**New files:** `knip.json`.

**Evidence:** `npm run knip` **exit 0, 0 findings, 0 configuration hints** (run without
`--no-exit-code`, because a gate that masks its own exit code is not a gate); `npm test` **472/472**;
`npx tsc --noEmit` clean; `verify:docs` **6/6**; `npm run build` exit 0.

## WP-4 — Executor host (repo-side done, implements ADR-014)

An Ubuntu 24.04 provisioning script: a dedicated unprivileged runner user, `bubblewrap`, a hardened
`systemd` unit with restart-on-failure, a bind on `localhost` and the tailnet only. `verify:host`
preflight. A reboot-mid-run drill: `--resume` yields no duplicate commits and a clean tree. Operator-
blocked pieces are listed with owners, never stubbed.

**Audit finding (2026-10-16).** The row above had been marked `done` in an uncommitted working-tree
edit. The audit found no evidence behind it: no `*.service` file, no provisioning script, no
`verify:host` in `scripts/` or `package.json`, no tailnet configuration, and no reboot drill anywhere in
`test/` or `scripts/` — the word "reboot" occurs only in this file and in ADR-014 itself.
ADR-014's status is still **Proposed**, which by the Constitution's Scope rule 2 means the code that
satisfies it has not landed. The row is corrected to open.

**Landed (repo-side).** The audit's list is now closed item by item:

- `software_factory/host/software-factory-executor.service` — a hardened unit (`User=runner`,
  `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `Restart=on-failure`).
- `software_factory/host/provision-executor-host.sh` — an idempotent provisioning script; it installs the
  unit, creates the runner + directories, leaves an empty mode-600 credential file, and names the
  operator-only actions (VPS, tailnet, deploy keys) instead of doing them.
- `scripts/verify-host.ts` + `npm run verify:host` — the preflight. It refuses a public bind, a runner
  that can `sudo`, a credential file that is not mode-600 root, a missing unit, a unit missing its
  hardening directives, or a `bubblewrap` that cannot create a container.
- `FACTORY_BIND_HOST` in `src/configurations/runtimeConfig.ts`, wired into `server.listen` — the bind
  setting the policy reads. Syntax is the parser's job; the private-only *policy* is
  `evaluateBindHost`, exercised by `test/executor-host-bind.test.ts` (8 cases).
- ADR-014 flipped to **Accepted** for the decisions enforceable in this repository.

**Negative proof.** On this dev machine `npm run verify:host` exits 1 with three real failures — the
runner is in the `sudo` group, there is no credential file, and the unit is not installed — and
`npm run verify:host -- --bind-only` exits 1 for an unset/public `FACTORY_BIND_HOST`. The preflight
does not pass on a machine that is not the executor host.

**Still blocked (owner: operator).** The host itself: a VPS, tailnet membership, and scoped deploy
keys. The reboot-mid-run drill on that host, and the tailnet-unreachability check from a non-tailnet
address. The repo-side half of the drill is `test/loop-die-resume.test.ts` (SIGKILL mid-verification →
`--resume` → one commit, clean tree), which is not a substitute for the on-host drill and is not
recorded as one.

## WP-5 — Phone surface (repo-side done)

A mobile-first Loop tab: submit a goal or an issue, a run list, live events, and a two-phase cancel
with large touch targets. Outbound notifications (done, STUCK, hard stop) through `WebhookService` and
the egress door, with a signed-delivery test. Evidence: API tests plus the operator's recorded
on-device check.

**Audit finding (2026-10-16).** The row above had been marked `done` in the same uncommitted edit.
What actually exists: `LoopControlPanel.tsx` (Sprint 24) covers run submit, run list, live SSE events
and goal drafting, and `src/api/routes/loop.routes.ts` already serves `POST /issues`
(`:58`), `GET /runs/:id/cancel` (`:83`) and the two-phase `POST /runs/:id/cancel` (`:112`). Missing: the
UI calls none of the issue or cancel routes — the panel's "Stop" button only aborts the local event
stream — and `WebhookService` has **no production caller at all**, so no loop lifecycle event is
dispatched as a signed notification. `test/webhook-service.test.ts` (Sprint 25) proves the service
works; it does not prove anything calls it. No on-device recording exists. The row is corrected to open.

**Landed (repo-side).**

- `src/components/LoopControlPanel.tsx` now calls the real routes: an issue-submit field with a
  "Draft from issue" action (`POST /issues`), and a runs-table "Stop run" button whose two-phase
  confirmation (`GET` then `POST /runs/:id/cancel`) shows the server's effect string and is gated on
  the real `loop:cancel` permission (`rbacService.ts:47`). The old "Stop" button, which only aborted
  the local SSE stream, is renamed "Hide" so it no longer reads as a cancel.
- `src/services/loopControlService.ts` dispatches `loop.run.settled` through `WebhookService` at the
  settlement boundary — the exact point the run reaches a terminal state — reading the durable record
  so the payload survives a restart. Fire-and-forget: a delivery failure is logged and never fails the
  run.
- `test/loop-webhook-delivery.test.ts` drives a real settled run and asserts exactly one signed
  delivery to the subscribed tenant, none to another, and that a failing receiver is recorded without
  failing the run. **Negative proof:** with the `loopControlService` wiring stashed, the first case
  fails ("exactly one delivery must be attempted").

**Still blocked (owner: operator).** The recorded on-device check: the operator opens the Loop tab on
the phone over the tailnet and records the on-device run. The API and UI behaviour is proven; the
phone-in-hand frame is not.

## WP-6 — Skills bridge (repo-side done, implements ADR-013)

A starter set vendored into `skills/` with provenance and sha256 pins; unpinned or modified files are
refused. Proposed set: `grill-me`, `to-prd`, `to-issues`, `tdd`, `diagnose`, `handoff`,
`improve-codebase-architecture` (Pocock); `agent-orchestration`, `ops-and-setup` (Ondrej). Wired by
role and stage in doctrine (manifest-pinned): intake, implementer, STUCK escalation, reviewer. Default
**OFF** behind a flag.

**Landed (repo-side).**

- **The pin gate** — `skillRegistryService.ts`: `loadPinnedSkills` refuses a skill with no pin
  (`SKILL_UNPINNED`), whose bytes differ from the pin (`SKILL_PIN_MISMATCH`), or whose pin records no
  licence (`SKILL_LOCK_INVALID`). `loadSkills` stays the inspection surface; influence and inspection
  are separate switches. `skills-lock.json` gained a `repo-hygiene` entry with its licence (MIT) and
  sha256; the opencode tooling entries are carried unchanged rather than given a fabricated licence.
- **The fenced seam** — `skillInjectionService.ts`: `fencedSkillBlock` labels the block untrusted
  reference text, delimits it, and refuses a skill whose body names a network endpoint
  (`SKILL_NAMES_EGRESS`, ADR-013 §6). `injectSkills` returns the prompt byte-for-byte when off.
- **The doctrine flag** — a `skills: { inject, byRole }` block in `doctrine/loop.json`, default
  `{ inject: false, byRole: {} }`, parsed fail-closed. OFF reads no skill file at all.
- **The role wiring** — `SkillInjectionService.advisoryForRole(role)` is called at the four real
  prompt builders: `buildPrompts` (implementer), `buildReviewPrompts` (reviewer), and the drafter path
  in `goalIntakeService`/`issueIntakeService`.
- ADR-013 flipped to **Accepted**.

**Proof (`test/skills-bridge.test.ts`, 17 cases).** An unpinned skill refuses; a modified skill
refuses; a pin with no licence refuses; the shipped `repo-hygiene` is pinned and a tamper with it is
refused; OFF is byte-identical to never wiring the seam; ON appends the fenced block to the task only,
leaving the system prompt and the unit's criteria/verify command untouched; the shipped doctrine leaves
the flag off. **Negative proof:** with `loadPinnedSkills` neutralised, 6 of the 17 fail (the unpinned,
modified, unlicensed, missing-lock, shipped-tamper and inspection cases) — the gate is what makes them
pass.

**Still blocked (owner: engineering).** Vendoring the Pocock or Ondrej *content*: each
source needs its licence and source commit confirmed before its bytes may be recorded in the lock, and
ADR-013 §7 says adoption into the run path waits on WP-7 showing a measured effect. The bridge is proven
against the in-repo skill; the external set is named, not stubbed. (The owner is engineering, not the
skill authors: their content is public and MIT, so nothing external gates the work — Sprint 33, WP-0
corrects this.)

## WP-7 — Measurement (blocked — no model reachable; named, not stubbed)

A benchmark of 12–15 canned tasks across at least three repositories, run with and without skills.
Recorded: first-attempt rate, STUCK rate, failure classes, wall time, and cost per verified commit,
labelled by model. Skill adoption is decided from the data. If the hosted path is operator-blocked,
run local, label the results, and state what was not measured.

**Blocked, and not worked around.** Neither path is reachable from this environment: the hosted
frontier model is the operator blocker (an allowlisted secret reference, a permitted host, and spend
cap — `hosted-frontier-model`), and the local fallback the sprint expected is not running here — no
Ollama process, nothing listening on `:11434`, and the binary is not executable from the agent shell.
Probed 2026-10-16.

**No harness was built.** A 12–15-task with/without-skills scaffold that nobody can execute would be
capability theater: it would add a runner, a task set and a table, and prove nothing about skills. The
measurement is one command once a model exists (`npm run factory:run` per task per condition, then
read the durable run records). Land that when the operator provides model access; until then the
ecosystem is coherent without it — the skills bridge ships **OFF**, and adopting the vendored skills
is a blocked capability (`external-skill-adoption`) whose stated precondition is exactly this data.

## Parked (named, not worked)

Maintenance sweeps, mutation testing on the gate suite, Rust runtime ownership, the JSON-ledger scaling
trigger, graduating `unrelated-writes` to `enforce`, and enabling learning injection (ADR-012 §6).
