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

## The two runtimes

This repository contains two services that enforce the same tenant model independently.

| | TypeScript service (`src/`, `server.ts`) | Rust runtime (`software_factory/`) |
|---|---|---|
| Role | Product workspace: jobs, approvals, evidence, audit | High-throughput telemetry ingestion and transformation |
| Storage | Single-writer JSON ledger (`src/services/durableStore.ts`) | Appwrite |
| State | **Tenant registry is in-memory** | Tenant profiles in memory, credentials at startup |
| Scaling | **One writer. Do not run replicas.** | Stateless; horizontal scaling is safe |
| Port | 3000 | 8080 |

The TypeScript ledger is protected by a process-lifetime writer lock. A second process
against the same data directory exits 75 rather than starting, because the adapter rewrites
the whole file on every change and two writers would silently overwrite each other.

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
| `FACTORY_MODEL_ALLOWED_HOSTS` | production | Egress allowlist for model providers. |
| `FACTORY_ALLOWED_SECRET_REFS` | production | Names a job may substitute into a request. |
| `ALLOW_INSECURE_LOCAL` | no | Only for local work; refused when `NODE_ENV=production`. |

A request carries its credential in `x-tenant-id` and `x-api-key`. A credential issued for
one tenant is refused with `403 TENANT_CREDENTIAL_MISMATCH` for any other, and a tenant with
no provisioned credential is unwritable.

## Running the Rust runtime

```bash
cd software_factory
cargo build --release
GEMINI_API_KEY=... \
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1 \
APPWRITE_PROJECT_ID=... \
APPWRITE_API_KEY=... \
TENANT_API_KEYS="tenant_re_8841:...,tenant_hc_1042:..." \
./target/release/software_factory
```

All five are required; the process exits 1 naming the missing one. `GEMINI_MOCK=1` enables
the deterministic mock for local work, and its output is labelled `"mock": true` so a
fabricated response cannot be mistaken for inference. A key bound to two tenants is rejected
at startup.

Endpoints: `/health` (liveness, public), `/ready` (readiness, 503 when unconfigured),
`POST /api/v1/telemetry/ingest`, `GET /api/v1/tenants/me`.

## Verifying

```bash
npm test                    # 76 tests
npx tsc --noEmit            # types
npm run verify:layer1       # 34 checks against the built server
npm run verify:layer2       # 26 checks: tenant isolation
npm run verify:layer3       # 24 checks: error contract, writer lock

cd software_factory
cargo test                  # 15 tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
python3 scripts/verify-k8s.py   # 51 manifest assertions
```

The three harnesses start the built server and drive it over HTTP, then assert nothing is
left listening. A unit test cannot pass while the real request path is unguarded; several
defects in 4.7.0 were found only by the harnesses.

## Known limits

These are real and are not scheduled work:

- **The tenant registry is in-memory.** Provisioned tenants do not survive a restart, and
  the TypeScript service cannot be scaled horizontally. A credential that stops matching a
  tenant is the only thing that keeps a stale tenant from being served.
- **The Docker image has never been built.** It is configured to run as non-root and to
  contain no secrets; that is verified by inspection, not by a build.
- **Plaintext tenant credentials are held in process memory** for the process lifetime.
- **The k8s NetworkPolicy permits egress on 443 to `0.0.0.0/0`.** Narrow it before
  production.
- **The Rust runtime has no metrics endpoint.**

See `sprints/sprint-15-production-hardening.md` for the full record, including the fixes
that were reverted to confirm the tests would fail without them.

## Current readiness

The repository has completed the founder-workspace and bounded-harness implementation program. The current system is suitable for a **controlled daily pilot on registered, low-risk projects**.

Verified capabilities include:

- Tenant-scoped durable jobs, approvals, evidence, and audit records.
- Canonical project registration and a daily workspace inbox.
- Definition-of-done tasks and continuation reports for incomplete products.
- Repository-specific verification profiles for Node, Android Gradle, Rust Cargo, Python, and Git integrity.
- Bounded repair loops with failure classification and retry limits.
- Ephemeral commit snapshots with sanitized execution metadata, disabled network policy, time limits, output limits, and cleanup.
- Approval-gated immutable filesystem releases with checksums, health checks, current-release pointers, and rollback targets.
- Durable failure records, prescribed next actions, escalation, and resolution evidence.
- Post-launch outcome records for adoption, time saved, defects, incidents, client acceptance, revenue, and learning.
- Graduated autonomy sessions with allowlisted actions, step budgets, retry budgets, and cost budgets.
- Durable agent queues with worker leases, retry recovery, cancellation, and completion evidence.
- Provider-to-task model execution proposals with explicit tool-applier boundaries.
- Sandbox policies covering source boundaries, network, secret references, resource budgets, timeouts, and runtime images.
- Post-deployment observation windows, health-failure records, rollback recommendations, and ordered worktree merge recovery.
- Project-family adapters and deterministic secret/package quality gates.
- An unattended execution loop driven by a strict task document: stage gates, three attempts per
  unit then STUCK, one verified commit per unit, hard stops, checkpoint/resume, and a run report
  written on every outcome.

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

Software Factory is a modular TypeScript/Express application with a React operations surface and a durable local ledger. The architecture is organized around four boundaries:

1. **Control layer** — Constitution, ADRs, product briefs, implementation plans, completion tasks, approval policies, and evidence contracts.
2. **Agency layer** — Repository preparation, explicit branch modification, verification, previews, context refresh, release preparation, and bounded autonomy.
3. **Runtime layer** — Tenant-scoped jobs, durable persistence, failure records, audit events, quality snapshots, outcomes, and recovery state.
4. **Adapter layer** — Verification profiles, filesystem release, future hosted deployment, execution sandboxes, model providers, and domain-specific integrations.

The core domain is kept separate from replaceable infrastructure so local-first operation can grow into hosted execution without changing the product contract.

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
- **Failure is bounded and visible.** Three attempts per unit, each quoting the previous refusal
  back to the model and rolling the tree back first; then STUCK, and the run continues with the
  next independent unit.

The format of the input is specified in
[docs/TASK_DOCUMENT_FORMAT.md](docs/TASK_DOCUMENT_FORMAT.md). The rules the loop enforces are in
[doctrine/DOCTRINE.md](doctrine/DOCTRINE.md).

```bash
npm run verify:loop        # doctrine manifest, gate wiring, 7 end-to-end scenarios, CLI contract
npm run doctrine:manifest  # re-pin after editing doctrine/ (then re-review the diff)
```

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
software_factory/       Rust runtime foundation and domain adapters
appwrite-functions/     Optional Appwrite integration functions
```

## Read the operating contracts

- [Harness Engineering Contract](docs/HARNESS_ENGINEERING_CONTRACT.md)
- [Founder Operating Playbook](docs/FOUNDER_OPERATING_PLAYBOOK.md)
- [Product Foundry Context](docs/PRODUCT_FOUNDRY_CONTEXT.md)
- [Repository Context Index](docs/REPOSITORY_CONTEXT_INDEX.md)
- [Task Document Format](docs/TASK_DOCUMENT_FORMAT.md)
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
