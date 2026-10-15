# Sprint 31 — The Reproducible Workhorse

**Status:** in progress — WP-0 governance landed; ADR-013 and ADR-014 signed off 2026-10-15; WP-1…WP-7 pending · **Opened:** 2026-10-15 · **Closed:** —

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
| WP-1 | Reproducibility: a fresh clone runs green anywhere (hermetic tests, a loud sandbox preflight, `bubblewrap` in CI, a tracked contributor `AGENTS.md`) | `verify:fresh-clone` red on the pre-fix tree, green after | pending |
| WP-2 | Truthful docs: README counts and the capability list generated from the manifest; stale claims removed; the Manus audit archived | no README figure that a command does not reproduce | pending |
| WP-3 | Dead-code gate: `knip` (or equivalent) in CI; every unreferenced export wired or removed | the gate fails on the pre-fix tree; the tree is clean after | pending |
| WP-4 | Executor host: an operator-owned Linux host, unprivileged runner, `bubblewrap`, hardened `systemd`, tailnet-only bind (implements ADR-014) | reboot-mid-run drill passes on a real host | pending |
| WP-5 | Phone surface: mobile-first Loop tab (goal/issue submit, run list, live events, two-phase cancel) + signed outbound notifications via `WebhookService` | delivery test + the operator's recorded on-device check | pending |
| WP-6 | Skills bridge: vendor a starter set with provenance + sha256, refuse unpinned/modified, wire by role, default OFF (implements ADR-013) | an unpinned skill refuses; a modified one refuses | pending |
| WP-7 | Measurement: 12–15 canned tasks across ≥3 repos, with and without skills | a table of first-attempt rate, STUCK rate, wall time, cost per verified commit | pending |

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
- **Skill sources and licences (owner: operator + engineering).** WP-6 vendors a starter set; the
  exact files, their commits, licences, and sha256 pins are a reviewed decision.
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

**Sign-off:** ADR-013 and ADR-014 were approved 2026-10-15, so WP-1 may begin. Both ADRs remain
**Proposed** in status until the code that satisfies them lands (WP-6 and WP-4), per the Constitution's
scope rule.

## WP-1 — Reproducibility (planned)

A fresh clone runs the full suite green with no undeclared local state. Tests stage their own fixtures;
the doctrine self-stage test asserts on tracked evidence or a fixture, not on `process.cwd()` contents.
A preflight fails **loudly** with remediation text when `bubblewrap` or user namespaces are
unavailable; sandbox tests never skip silently. `bubblewrap` is installed in CI. A contributor
`AGENTS.md` is tracked. `verify:fresh-clone` clones to a temp dir, runs `npm ci`, and runs the suite.

## WP-2 — Truthful docs (planned)

`README.md` counts and the capability list are generated from the manifest / CI output; the duplicate
"Remote control plane" section is removed; the model-locality wording is corrected (the egress guard
sees only loopback for a daemon that forwards); extrapolated throughput is replaced by measured
figures only; `DEEP_READINESS_AUDIT.md` moves to `docs/archive/` with a superseded banner; a
`docs/audit/CODEBASE-INDEX.md` is generated from the tree.

## WP-3 — Dead-code gate (planned)

`knip` (or equivalent) runs in CI. Each unreferenced export in the finding above is deleted or wired.
If `WebhookService` stays, WP-5 is its production caller.

## WP-4 — Executor host (planned, implements ADR-014 as approved)

An Ubuntu 24.04 provisioning script: a dedicated unprivileged runner user, `bubblewrap`, a hardened
`systemd` unit with restart-on-failure, a bind on `localhost` and the tailnet only. `verify:host`
preflight. A reboot-mid-run drill: `--resume` yields no duplicate commits and a clean tree. Operator-
blocked pieces are listed with owners, never stubbed.

## WP-5 — Phone surface (planned)

A mobile-first Loop tab: submit a goal or an issue, a run list, live events, and a two-phase cancel
with large touch targets. Outbound notifications (done, STUCK, hard stop) through `WebhookService` and
the egress door, with a signed-delivery test. Evidence: API tests plus the operator's recorded
on-device check.

## WP-6 — Skills bridge (planned, implements ADR-013 as approved)

A starter set vendored into `skills/` with provenance and sha256 pins; unpinned or modified files are
refused. Proposed set: `grill-me`, `to-prd`, `to-issues`, `tdd`, `diagnose`, `handoff`,
`improve-codebase-architecture` (Pocock); `agent-orchestration`, `ops-and-setup` (Ondrej). Wired by
role and stage in doctrine (manifest-pinned): intake, implementer, STUCK escalation, reviewer. Default
**OFF** behind a flag.

## WP-7 — Measurement (planned)

A benchmark of 12–15 canned tasks across at least three repositories, run with and without skills.
Recorded: first-attempt rate, STUCK rate, failure classes, wall time, and cost per verified commit,
labelled by model. Skill adoption is decided from the data. If the hosted path is operator-blocked,
run local, label the results, and state what was not measured.

## Parked (named, not worked)

Maintenance sweeps, mutation testing on the gate suite, Rust runtime ownership, the JSON-ledger scaling
trigger, graduating `unrelated-writes` to `enforce`, and enabling learning injection (ADR-012 §6).
