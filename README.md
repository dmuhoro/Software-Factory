# Software Factory

**Software Factory is a durable product-manufacturing workspace for turning ideas and incomplete repositories into verified, releasable products.**

It is designed for a founder or small engineering team that wants a repeatable operating loop:

```text
Idea or incomplete repository
  → product brief
  → implementation plan
  → controlled branch
  → bounded implementation
  → repository-specific verification
  → preview artifact
  → approval gate
  → release and health check
  → rollback if required
  → outcome review
  → institutional learning
```

The system is intentionally evidence-first. It does not treat a successful build as proof that a product is complete, useful, secure, or ready for production.

## The runtime

One service enforces the tenant model: the Node server (`src/`, `server.ts`), the product
workspace for jobs, approvals, evidence and audit. It listens on `PORT` (3000 by default; the
Kubernetes manifest sets `PORT=8080`).

Until Sprint 34 a second service existed — a Rust crate at `software_factory/`, Axum + Tokio,
enforcing the same tenant model independently and on its own tenant store. No user reached it,
nothing routed traffic to it, and its only live coupling was to the release ritual; it was deleted
under Option C (`docs/RUST-RUNTIME-DECISION-MEMO.md`). The last commit whose tree contained it is
tagged `rust-runtime-final`, so it can be recovered, and ADR-003 is superseded by
[ADR-016](docs/adr/ADR-016-one-runtime.md).

The ledger is protected by a process-lifetime writer lock. A second process
against the same data directory exits 75 rather than starting, because the adapter rewrites
the whole file on every change and two writers would silently overwrite each other.

The data directory is a readiness check in its own right, and a failure there is fatal at
startup with the same exit 75. Before a port is bound the service writes a bounded payload
into the directory, flushes it with `fsync`, and reads it back — so a directory that is
read-only, not creatable, or not durable is refused rather than discovered on the next real
write — and the volume's free space is checked against a 64 MiB floor, because a near-full
volume accepts the probe write and then fails the whole-file rewrite that follows.

## Running the TypeScript service

```bash
npm ci
cp .env.example .env      # then fill in real values; see below
npm run build
npm start
```

Every credential is required. The service exits non-zero at startup rather than starting
with a placeholder, because a service that starts unconfigured fails quietly at 3am.

| Variable | Required | Notes |
|---|---|---|
| `FACTORY_TENANT_CREDENTIALS` | yes | `tenantId:secret,tenantId:secret`. One secret must map to exactly one tenant. |
| `FACTORY_API_KEY` | yes | `platform_operator` credential, for cross-tenant operations. |
| `FACTORY_DATA_DIR` | no | Ledger location. Single-writer. |
| `FACTORY_WORKSPACE_ROOT` | production | Bounded directory the service may write to. |
| `FACTORY_MODEL_ALLOWED_HOSTS` | production | Egress allowlist for model providers. Add `generativelanguage.googleapis.com` to enable live Gemini. |
| `FACTORY_ALLOWED_SECRET_REFS` | production | Names a job may substitute into a request. Add `GEMINI_API_KEY` to enable live Gemini. |
| `ALLOW_INSECURE_LOCAL` | no | Only for local work; refused when `NODE_ENV=production`. |

A request carries its credential in `x-tenant-id` and `x-api-key`. A credential issued for
one tenant is refused with `403 TENANT_CREDENTIAL_MISMATCH` for any other, and a tenant with
no provisioned credential is unwritable.

## Verifying

```bash
npm test                    # unit + source-invariant tests
npm run verify:docs         # documentation gates
npm run verify:fresh-clone  # a clean clone installs and verifies (needs bubblewrap)
npx tsc --noEmit            # types
npm run verify:host         # the executor host is the one ADR-014 describes
npm run verify:layer1       # 36 checks against the built server
npm run verify:layer2       # 26 checks: tenant isolation
npm run verify:layer3       # 24 checks: error contract, writer lock
npm run verify:preview-plane # 6 checks: ephemeral worktree + dev server sessions
npm run verify:bug-detective # 7 checks: advisory diagnosis, deterministic output
npm run verify:observability # read-only metrics/health views, blocked capabilities name owners

python3 scripts/verify-k8s.py   # 57 manifest assertions
```

The three harnesses start the built server and drive it over HTTP, then assert nothing is
left listening. A unit test cannot pass while the real request path is unguarded; several
defects in 4.7.0 were found only by the harnesses. The sandbox tests execute verification
commands inside `bubblewrap`: a run whose doctrine enables the sandbox refuses to start unless
`bwrap` is present and can actually unshare, so a host without it fails loudly rather than
running verification commands unsandboxed. `npm run verify:fresh-clone` proves the same suite
passes from a clone that has none of the working tree's gitignored files.

`npm run verify:host` is the executor-host preflight (ADR-014). It is not part of `npm test`
because it inspects the machine it runs on, not the code: it refuses a host whose bind is public,
whose runner can `sudo`, whose credential file is not mode-600 root, whose hardened unit is
missing, or whose `bubblewrap` cannot create a container. `npm run verify:host -- --bind-only`
checks just the bind policy, which is what CI can check without a provisioned host.

## Known limits

These are real. Each names the record that establishes it and either the command that shows it
or the owner who unblocks it. `npm run verify:docs` fails if any line here disagrees with the
non-conformance table in `docs/CONSTITUTION.md`.

- **The TypeScript service runs as exactly one replica.** A single-writer JSON ledger and an
  in-memory tenant registry mean a second process against the same data directory would
  corrupt the ledger, so it exits 75 rather than starting. Horizontal scale needs a shared
  store and is the one open non-conformance, `NC-2` (`docs/CONSTITUTION.md`; `docs/adr/ADR-015`
  records the shared-store decision, Proposed). A restart is
  *not* a limit: the registry is rebuilt from the durable ledger on boot, and provisioned and
  scoped credentials survive it (`npm test -- test/l4-durable-tenancy.test.ts`). <!-- nc: NC-2 -->
- **Plaintext tenant credentials are held in process memory** for the process lifetime and are
  not zeroized. The object no longer exposes them, but a core dump still would; this is what
  remains of `NC-7` (`scripts/verify-layer4.sh` L4-9). <!-- residual: NC-7 -->
- **There is no external identity provider.** A caller that presents a provisioned tenant
  credential is trusted; there is no interactive login, so anyone holding a tenant id and its
  secret has that tenant's access. <!-- owner: operator -->
- **There are no dashboards, alerts, or on-call** on the Prometheus series the runtime exposes at
  `/metrics` (`src/api/routes/factory.routes.ts`). The endpoint exists; the
  paging does not. <!-- owner: operator -->

Two former limits are closed and are recorded here so they do not quietly reopen: the image
builds and is asserted against the built artifact (`npm run verify:image`), and the
Kubernetes NetworkPolicy's allow-all egress was replaced by an allowlist rendered from observed
DNS answers (`npm run render:egress`; `scripts/verify-k8s.py` fails if the
wildcard returns). See `sprints/sprint-15-production-hardening.md` for the full record, including
the fixes that were reverted to confirm the tests would fail without them.

## Current readiness

The repository has completed the founder-workspace and bounded-harness implementation program. The current system is suitable for a **controlled daily pilot on registered, low-risk projects**.

The capabilities below are the code's own declaration of what it can do. This is the same manifest the
API serves at `GET /api/factory/capabilities` and the evidence page renders; the table is generated by
`npm run render:readme`, so it cannot list a capability the code does not declare, and `npm run
verify:docs` fails when this file drifts from the manifest. Every live entry names the command that
demonstrates it; every blocked entry names the operator who must unblock it. The richer workspace
surfaces — jobs, approvals, releases, outcomes — are described under **Operating the factory** below.

<!-- readme-capabilities:start (generated by scripts/render-readme.ts; do not edit by hand) -->
| Capability | Status | Demonstrated by / owner |
|---|---|---|
| Unattended execution loop | live | `npm run verify:loop` |
| Interactive intake (grill session) | live | `npm test -- test/grill-session.test.ts` |
| Durable failure classification | live | `npm test -- test/loop-failure-class.test.ts` |
| Unrelated-writes guard (shadow) | live | `npm test -- test/unrelated-writes.test.ts` |
| Bounded learning digest | live | `GET /api/loop/learning-digest` |
| One model-egress door | live | `npm test -- test/egress-confinement.test.ts` |
| Tenant-scoped control plane | live | `npm test -- test/loop-control-plane.test.ts` |
| Fail-closed readiness | live | `GET /api/factory/health` |
| Capability manifest | live | `GET /api/factory/capabilities` |
| Declarative skills registry | live | `GET /api/factory/skills` |
| Vendored, hash-pinned advisory skills | live | `npm test -- test/skills-bridge.test.ts` |
| Adopting external skill content | live | `npx tsx scripts/vendor-skill.ts --check` |
| Measured effect of the skills | blocked | blocked — owner: harness: engineering; model run: operator |
| Hosted frontier model | blocked | blocked — owner: operator |
| Pull-request configuration preflight (opens nothing) | live | `npm run verify:pr-config` |
| Live GitHub pull request | blocked | blocked — owner: operator |
| Sandboxed execution in the shipped image | live | `npm run verify:image node` |
| External cloud runtime | blocked | blocked — owner: operator |
| Preview plane | live | `npm run verify:preview-plane` |
| AI bug detective (advisory, bounded, fail-closed) | live | `npm test -- test/bug-detective.test.ts` |
| Dual-language reporting (technical + founder/CEO) | live | `npm test -- test/dual-language-report.test.ts` |
| Tool-agnostic IDE/CLI boundary | planned | `npm run verify:tool-agnostic-boundary` (planned) |
| Dashboards, alerts, on-call | blocked | blocked — owner: operator |
| Post-deployment health check and rollback | blocked | blocked — owner: operator |
| Container / microVM executor for untrusted code | blocked | blocked — owner: operator |
| Hosted deployment target with isolated secret injection | blocked | blocked — owner: operator |
| External identity provider / interactive login | blocked | blocked — owner: operator |
| Horizontal scale via shared store | blocked | blocked — owner: engineering |
| Founder jobs and client-like dry runs with evidence packs | blocked | blocked — owner: operator |
| Cycle time, defect rate, repair rate, recovery time, product outcomes | blocked | blocked — owner: operator |

**17 live · 12 blocked · 1 planned.** Every live entry names the command that
demonstrates it; every blocked entry names the operator who must unblock it. A capability appears
here only when it is declared in `src/services/capabilityManifest.ts` — this table is generated by
`npm run render:readme`, so it cannot describe a capability the code does not.
<!-- readme-capabilities:end -->

The system is **not yet an unrestricted autonomous production company**. A hardened container or microVM executor, a provider-specific hosted deployment adapter, production secret injection, and full local reality verification remain explicit boundaries and readiness gates.

## Why this exists

Most development automation optimizes for code generation. Software Factory optimizes for **operational completion**:

- What is the product supposed to accomplish?
- What remains unfinished?
- What evidence proves each acceptance criterion?
- Which actions are reversible?
- Which actions require approval?
- What failed, who owns the next action, and how many retries remain?
- What happened after release?
- What should the next product inherit or avoid?

The result is a durable operating memory for product work rather than another transient coding assistant.

## Architecture

Software Factory is organized into seven layers, each with a single responsibility and a strict boundary:

| Layer | Responsibility | Boundary rule |
|-------|---------------|---------------|
| L1 Control | Constitution, ADRs, doctrine, approval policies, capability manifest | No runtime writes; doctrine loads from outside the target repo |
| L2 Agency | Unattended loop (PLAN→IMPLEMENT→VERIFY→COMMIT→REPORT), branches, previews | The loop is the only writer of a target tree |
| L3 Runtime | Tenant-scoped jobs, durable ledger, outcomes, audit, recovery | Single writer; tenant-scoped; fail-closed readiness |
| L4 Adapter | Verification profiles, execution sandbox, deployment, model providers | Provider-specific behavior behind explicit ports |
| L5 Diagnostic | AI bug detective: error flagging, root-cause, remediation advice | Advisory only; never writes to a target tree; fail-closed |
| L6 Observability | Dashboards, alerts, on-call, metrics, health, cycle-time/defect/repair | Read-only views of durable records |
| L7 Interface | Frontend tabs, dual-language reporting, tool-agnostic IDE/CLI boundary | Every output has a technical and a founder/CEO rendering |

Key invariants carried across all layers:

- **Fail closed.** A check that cannot run refuses; it never degrades to "allowed".
- **No fabricated claims.** Every capability names the command or route that proves it (capability manifest).
- **No second writer.** Only the loop writes to a target tree; the diagnostic layer never writes.
- **Advisory diagnostics.** The bug detective emits diagnoses, never edits; any fix still runs VERIFY → REVIEW → COMMIT through L2 gates.
- **Dual vocabulary.** Every durable record renders in both technical and founder/CEO language; no figure appears without a named command that reproduces it.
- **Tool-agnostic.** The doctrine, gates, and evidence boundary live outside Cursor/Cline/any IDE; editors are clients of the boundary, not authors of it.

## Quick start

### Prerequisites

- Node.js 22+
- npm
- Git

### Install and configure

```bash
npm install
cp .env.example .env
```

At minimum, configure a strong `FACTORY_API_KEY` for protected API access. Keep credentials outside the repository and never place them in briefs, evidence, prompts, logs, or context records.

### Verify the repository

```bash
npm run verify
```

This runs TypeScript checking, the serialized test suite, and the production build.

### Run locally

```bash
npm run dev
```

The server exposes the API and serves the frontend operations surface. Production mode uses the generated bundle:

```bash
npm run build
npm start
```

## Operating the factory

### 1. Register a project

Register a Git repository once inside the approved workspace boundary:

```bash
curl -X POST http://localhost:3000/api/workspace/projects \
  -H 'authorization: Bearer YOUR_FACTORY_API_KEY' \
  -H 'x-tenant-id: founder' \
  -H 'content-type: application/json' \
  -d '{"tenantId":"founder","name":"My Product","repositoryPath":"/workspace/my-product","kind":"personal"}'
```

### 2. Inspect the daily inbox

```bash
curl http://localhost:3000/api/workspace/inbox \
  -H 'authorization: Bearer YOUR_FACTORY_API_KEY' \
  -H 'x-tenant-id: founder'
```

The inbox surfaces projects, blocked jobs, unfinished jobs, pending approvals, and stale operational work.

### 3. Continue incomplete work

A continuation report identifies missing briefs, plans, branches, verification, previews, and completion tasks rather than restarting the repository from scratch.

```bash
curl http://localhost:3000/api/workspace/jobs/JOB_ID/continuation \
  -H 'authorization: Bearer YOUR_FACTORY_API_KEY' \
  -H 'x-tenant-id: founder'
```

### 4. Use the evidence gate

A job cannot be delivered until required completion tasks are complete, evidence exists, and the required approval is durable. Reversible actions can be automated within policy; irreversible actions require an explicit decision.

### 5. Record outcomes

After delivery, record measurable results such as time saved, adoption, client acceptance, defects, incidents, or learning. These records are the input to future quality improvement.

## Running the unattended loop

The loop takes one task document and runs PLAN → IMPLEMENT → VERIFY → COMMIT → REPORT for every
work unit in it, without asking anything, until each unit is committed, stuck, or the run hits a
hard stop.

```bash
npm run factory:run -- --repo /path/to/target --task /path/to/task.md
```

| Exit code | Meaning |
|---|---|
| `0` | every unit committed, each under a verification command that exited 0 |
| `1` | the run refused to start (dirty tree, bad document, doctrine drift) |
| `2` | the run finished, and at least one unit is STUCK or BLOCKED |
| `3` | the run halted at a hard stop (wall clock, attempts, commits, resources, doctrine) |

Options: `--tenant`, `--attempt-cap` (lowers doctrine's cap, never raises it), `--resume <runId>`,
`--report-dir`, `--json`. The run writes `<runId>.md` and `<runId>.json` to
`FACTORY_LOOP_REPORT_DIR` (default `.data/loop-runs/`) whatever its outcome — including a
refusal.

What makes it safe to leave alone:

- **The rulebook is configuration, not prose.** `doctrine/` holds the stage order, the attempt
  cap (3), the hard stops, the commit policy, the model assignments per role, and a hook list
  naming the gate that enforces each rule. `doctrine/manifest.json` pins every file's sha256; a
  doctrine that no longer matches its manifest is refused before any work starts.
- **Gates are code, and both directions are checked.** Every hook id resolves to an
  implementation in `src/services/loopGates.ts`, every rule's enforcement gate is declared by
  some stage, and a gate no stage declares is a test failure.
- **The target cannot supply its own rules.** The doctrine lives outside the target repository;
  the target's `AGENTS.md`, `.claude/`, `opencode.json` and friends are hashed into a quarantine
  manifest and never read, and every process the loop spawns gets
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
- **Evidence is executed, never narrated.** A unit is complete when its verification command ran
  and exited 0. The commit body records those commands and their exit codes, plus a
  `Proof: sha256:` digest; a model's own account is recorded and discarded.
- **Failure is bounded, classified, and visible.** Three attempts per unit, each quoting the previous refusal
  back to the model and rolling the tree back first; then STUCK, and the run continues with the
  next independent unit. Every failed attempt carries a machine-readable class — `security`,
  `verification`, `review`, `model`, `defect`, `environment`, `policy`, or `unknown` — derived purely from
  its refusal code and stage (no model), persisted on the record so it survives `--resume`, and
  summarised in the report's **Failure classes** section. A STUCK unit is also reported on the
  settlement webhook: the `loop.run.settled` payload carries a `stuckUnits` entry naming the unit's
  failure class, every failed attempt (what was tried), and a class-specific **next step**, so an
  operator's receiver learns a unit is stuck — and what to do — the moment the run settles.
- **A unit that cannot fail its own check, or cannot run it, is refused before the model is
  dialled.** A unit whose verification command already exits 0 on the starting tree is a no-op —
  nothing it does can satisfy the proof — so `no-op-unit` refuses it once instead of burning the
  attempt cap. A sandboxed command that dies with exit 127 because the sandbox masked its
  toolchain (for example a version-manager `node`/`npm` living under the masked `/home`) is named
  at the boundary that observed it (`SANDBOX_TOOLCHAIN_HIDDEN`), not retried three times.
- **A comment must not claim a value its code does not use.** `diff:comment-claim` compares each
  added comment against the line it annotates; a comment naming a value the code does not use
  refuses the unit.
- **A change nobody declared is observed.** The commit stages every change in the tree, so a
  formatter's rewrite or a tool's side effect would land under a message describing only the claimed
  work. `unrelated-writes` compares the working tree against the implementer's claimed files (and an
  allowlist) and names any file that changed without being claimed. It ships in **shadow mode** —
  `loop.json:unrelatedWrites.enforce` defaults to `false`, so the write is recorded and nothing is
  refused until an operator turns enforcement on. `npm run unrelated-writes:report` reads the
  recorded runs and lists every file the guard would refuse, by unit; it changes nothing, and the
  pre-registered rule for when enforcement may be turned on is in
  [sprints/sprint-33-closing-sprint.md](sprints/sprint-33-closing-sprint.md).
- **A skill is reference text, not authority.** When `loop.json:skills.inject` is on, a role may be
  shown the skills named for it in `byRole`, each pinned by sha256 in `skills-lock.json`. A skill is
  fenced and labelled untrusted, may not name a network endpoint, and can change no rule, gate, or
  model assignment; an unpinned or modified skill is refused. The flag defaults to `false`, so a run
  reads no skill file and every prompt is byte-identical. The one attempt-conditional role is
  `implementer-stuck`: from a unit's **second** attempt — after a real refusal, so the model has
  specific feedback — the implementer prompt gains the `diagnosing-bugs` skill; the first attempt
  never sees it.
- **A failed command reaches the next attempt with its file:line**, not just an exit code, so the
  model is told where to look.
- **Whether a skill helps is measured, not asserted.** `npm run bench:skills` runs the fixture tasks
  under `test/fixtures/bench/` with injection **on** and **off**, repeats each side, and applies a
  pre-registered rule. The design is **paired**: each fixture runs under both arms, so the decision is
  made per fixture, not by comparing two independent samples. A fixture counts for the skill when its
  aggregate first-attempt rate is higher with the skill on than off; an **exact sign test** over the
  non-tied fixtures must reject the null at α = 0.05 in favour of "on" **and** the aggregate
  first-attempt rate must improve by **≥ 10 percentage points** **and** neither the STUCK rate nor
  the refusal count may rise; otherwise the skill stays off. The report states the minimum detectable
  effect (MDE) at the observed fixture count, so a null result can be read as "not enough fixtures to
  decide" rather than "decided no". A `--dry` pass runs a stub and is labelled `stub: true`; such a
  report proves the harness and is refused as capability evidence.

  To run it for real, point it at a reachable model — the command is exactly:

      npm run bench:skills -- --model <provider>/<model> --tenant <tenant-id> --repetitions 3 --out artifacts/bench/skills-<date>.json

  Budget the wall time as `≈ 2 × repetitions × fixtures × t`, where `t` is the median `wallTimeMs`
  the report prints per run: two arms, `repetitions` repeats of each of the `fixtures` tasks
  (16 at present, 12 single-file and 4 multi-file), each side one full loop run. The report carries
  `wallTimeMs` per run so the second and later runs can be estimated from the first, and `tokens`
  only when the model path reported a count (`null` otherwise — the loop's execution path does not
  yet meter tokens, so a real number will not appear until it does).
- **A trial reports itself, and refuses a number it cannot derive.** `npm run trial:report -- --repo
  <path> --since <YYYY-MM-DD>` derives, from the ledger and git only: runs and their statuses, units
  attempted/done/stuck/blocked, failure classes (with unclassified failures counted, never guessed),
  which recorded commits still exist and are contained by HEAD, which were later reverted or
  repaired, wall time, and tokens when a usage event was actually recorded. A figure with no source
  is `null` and named under **Not derivable**; cost is always `null` because nothing in this product
  reports a price per call. The operator's judgement is recorded separately with `npm run trial:note`
  and printed labelled `source: operator`. The five readiness criteria and the success definition are
  fixed in advance in [docs/PRODUCTION_TRIAL.md](docs/PRODUCTION_TRIAL.md).


The format of the input is specified in
[docs/TASK_DOCUMENT_FORMAT.md](docs/TASK_DOCUMENT_FORMAT.md). The rules the loop enforces are in
[doctrine/DOCTRINE.md](doctrine/DOCTRINE.md). What the review stage can and cannot prove is
stated honestly in
[docs/ADVERSARIAL_REVIEW_SCOPE.md](docs/ADVERSARIAL_REVIEW_SCOPE.md).

The loop has been run end to end against real repositories, and the reports are kept. The model was
served by a local Ollama daemon (`gpt-oss:20b-cloud`); Ollama's `-cloud` models forward to a remote
host, so what this repository's egress guard observes is the loopback address of the daemon, **not the
model's true location** — which is exactly why the hosted path is declared `blocked` in the capability
manifest above. The figures below are the runs' own measurements, not extrapolations.

- **Software Factory ran the loop on itself** — run `looprun_cd5b2f682f3ca0f7c99ab731`, 2/2
  verified commits on attempt 1.
- **A real i18n batch on Daftari** — run `looprun_e8c12bcd603a16fe1dd9d02c68d`, 4/4 verified
  commits, all first attempt, 66 gates executed with 0 refused; 217.6s wall for 4 units.
  Daftari's `check-i18n` and typecheck were both green after.
- **A die-and-resume drill** — run `looprun_875b855f07096ade7d02c68d` was SIGKILLed mid-verification
  and resumed (`--resume`) to exactly one commit with the interrupted path restored to its last
  committed state.

The gate feedback loop, a refusal carried into the next attempt, and the reviewer refusing an
unrelated-file change are recorded in
[sprints/sprint-22-trustworthy-unattended-loop.md](sprints/sprint-22-trustworthy-unattended-loop.md).

```bash
npm run verify:loop        # doctrine manifest, gate wiring, 7 end-to-end scenarios, CLI contract
npm run doctrine:manifest  # re-pin after editing doctrine/ (then re-review the diff)
```

### Run it unattended on the executor host

Running the loop unattended means running it where it can be reached from a phone without opening
a port to the internet. ADR-014 fixes that host: a private address (loopback or tailnet), a
dedicated unprivileged runner, credentials owned by `root` and mode `600`, and a hardened
`systemd` unit. The repository ships the pieces the operator needs and refuses to run on a host
that does not match.

```bash
sudo deploy/host/provision-executor-host.sh   # idempotent; prepares the host
npm run verify:host                                     # refuses if the host does not match ADR-014
npm run verify:host -- --bind-only                      # the bind policy alone (CI-safe)
npm run verify:host -- --record                         # also write dated evidence under docs/evidence/
```

`provision-executor-host.sh` creates the runner user and directories, installs the unit, and
leaves an empty mode-600 credential file for the operator to fill. It does not create the VPS,
join the tailnet, or mint the deploy keys — those are operator actions, named in its output. The
unit binds only what `FACTORY_BIND_HOST` says; on the executor host that must be private.
`npm run verify:host -- --record` writes `docs/evidence/executor-host-<date>.md` — a dated record
of what was checked, written whether the preflight passed or failed.

The container image the loop runs in ships `bubblewrap`, and `bash scripts/verify-image.sh node`
proves it is present and can actually create a container as the unprivileged user, reporting the
runtime flags the sandbox needs (`--cap-add SYS_ADMIN`, `seccomp=unconfined`,
`apparmor=unconfined`) and failing closed when it cannot. The full operator procedure — host,
tailnet, credentials, proof, and the reboot drill — is in
[docs/RUNBOOK_EXECUTOR_HOST.md](docs/RUNBOOK_EXECUTOR_HOST.md).

## Supported verification profiles

The profile detector selects a repository-specific verification contract:

| Profile | Typical checks |
|---|---|
| Node/npm | Declared verify, lint, test, and build scripts |
| Android Gradle | Unit tests, lint, and offline release assembly |
| Rust Cargo | Format check, tests, and release build |
| Python | Ruff and pytest when declared |
| Git integrity | Diff and repository integrity fallback |

Unsupported or ambiguous projects should be explicitly configured rather than silently executed with guessed commands.

## Remote control plane

The loop can now be started, listed, inspected, and watched from an authenticated HTTP API or from
the in-browser operator panel.

- **REST:**
  - `POST /api/loop/runs` — start a run. Headers: `X-API-Key: <tenant key>`, `X-Tenant-Id: <tenant>`.
    Body: `{ "tenantId": "<tenant>", "repo": "/path/in/workspace", "taskDocument": "/path/in/workspace/task.md" }`
    → `202 { runId, repo, taskDocument, status: "running" }`.
  - `POST /api/loop/goals` — draft a parser-accepted task document from a natural-language goal.
    Body: `{ "tenantId": "<tenant>", "repo": "...", "goal": "...", "providerId": "...", "model": "..." }`
    → `201 { taskDocument: "/path/.factory-goal-drafts/...", draft, title, milestones, providerId, model }`.
  - `GET /api/loop/runs` — list all runs for the authenticated tenant.
  - `GET /api/loop/runs/:id` — return the durable run record for the authenticated tenant (404 for
    a foreign run).
  - `GET /api/loop/runs/:id/events` — SSE stream of recorded events, ending with `event: done`.
  - `POST /api/loop/grills` — start an interactive intake ("grill session"). Body:
    `{ "tenantId": "<tenant>", "repo": "...", "goal": "...", "providerId": "...", "model": "..." }`
    → `201 { sessionId, status, cap, questionNumber, question?, done }`. The factory asks **one**
    clarifying question at a time; the hard cap (`FACTORY_GRILL_MAX_QUESTIONS`, default 8, clamped
    1..32) is enforced by the service, not the model.
  - `GET /api/loop/grills/:id` — the durable session record for the authenticated tenant (404 for a
    foreign session).
  - `POST /api/loop/grills/:id/answers` — answer the outstanding question. Body: `{ "answer": "..." }`
    → the next question, or `done: true` when the model is satisfied or the cap is reached.
  - `POST /api/loop/grills/:id/finish` — draft the task document from the goal plus the transcript
    through the same parse-or-refuse path as `POST /api/loop/goals` → `201 { taskDocument, title, ... }`.
- **Browser panel:** the **Unattended Loop** tab in the frontend lets an operator paste a tenant API
  key (kept in memory only, never persisted to storage or the URL), draft a goal, submit a run, and
  tail its live stream. The **Interactive Intake** tab answers the same credentials question the same
  way, then runs a grill session turn by turn and drafts the task document when the interview ends.

## Security and safety model

Software Factory follows these non-negotiable policies:

- Every durable record is tenant-scoped.
- Production and other irreversible actions require approval.
- The repository remains the source of truth.
- Secrets are injected through the runtime environment, not persisted in job context.
- Verification and repair are bounded by time, output, retry, and action budgets.
- Failed work becomes visible with a failure class, owner, and next action.
- Required unfinished work prevents delivery completion.
- Context promotion requires explicit review and evidence.
- A release must have a health check and rollback target.

## Repository structure

```text
src/                    React application, API routes, services, models
server.ts               Express production entrypoint
src/services/           Durable jobs, workspace, execution, release, recovery, outcomes
src/api/routes/         Authenticated tenant-scoped APIs
doctrine/               Stage order, attempt cap, models per role, rules and hooks (outside the target)
test/                   Deterministic unit and integration tests
docs/                   Constitution, ADRs, contracts, and operating playbooks
sprints/                Sequential implementation records
deploy/k8s/             Kubernetes manifests for the runtime
appwrite-functions/     Optional Appwrite integration functions
```

## Read the operating contracts

- [Harness Engineering Contract](docs/HARNESS_ENGINEERING_CONTRACT.md)
- [Founder Operating Playbook](docs/FOUNDER_OPERATING_PLAYBOOK.md)
- [Product Foundry Context](docs/PRODUCT_FOUNDRY_CONTEXT.md)
- [Repository Context Index](docs/REPOSITORY_CONTEXT_INDEX.md)
- [Generated Codebase Index](docs/audit/CODEBASE-INDEX.md)
- [Task Document Format](docs/TASK_DOCUMENT_FORMAT.md)
- [Adversarial Review — True Scope](docs/ADVERSARIAL_REVIEW_SCOPE.md)
- [Machine-Building Contract](docs/MACHINE_BUILDING_CONTRACT.md)
- [Sprint 12: Real-World Readiness](sprints/sprint-12-real-world-readiness.md)
- [Sprint 14: Machine Building](sprints/sprint-14-machine-building.md)
- [Engineering Constitution](docs/CONSTITUTION.md)
- [Architecture Decision Records](docs/adr/)
- [Changelog](CHANGELOG.md)

## Roadmap to unrestricted autonomous production work

The next readiness gates are deliberately concrete:

1. Replace the restricted local execution adapter with a container or microVM boundary for untrusted code.
2. Connect one hosted deployment target with isolated secret injection.
3. Add real post-deployment observation and infrastructure rollback.
4. Complete five founder jobs and three client-like dry runs with evidence packs.
5. Measure cycle time, defect rate, repair rate, recovery time, and product outcomes across launches.
6. Expand autonomy only by approved action class and verified project profile.

The system should earn broader autonomy through successful evidence, not through a larger prompt or a higher claimed percentage.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Every change should preserve the Constitution, relevant ADRs, tenant isolation, evidence contracts, and green verification.

## License

Software Factory is released under the [MIT License](LICENSE).
