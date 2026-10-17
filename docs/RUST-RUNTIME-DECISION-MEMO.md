# Rust runtime decision memo — archive, own, or delete `software_factory/`

**Status: executed.** Sprint 34 WP-3 chose Option C (delete) and shipped it as
ADR-016. The crate is recoverable at tag `rust-runtime-final`.

- **Status**: **STOP FOR DANIEL** — a decision for the operator, not a sprint to start
- **Date**: 2026-10-17
- **Owner**: operator (the decision); engineering (any execution it authorizes)
- **Source of record**: `sprints/sprint-33-closing-sprint.md` WP-7
- **Sprint constraint**: this memo is the whole work package. It changes no code, no CI, no
  manifest, and no ADR. It records a decision for the operator and stops.

## The question

The repository ships **two services**. One is the Node control plane the product actually runs.
The other is a Rust crate, `software_factory/`, that no owner has claimed and that nothing routes
traffic to. This memo lays out the three ways to end that ambiguity — **archive it**, **keep it with
a named owner**, or **delete it** — and recommends one. The decision is the operator's, because it
is a product-direction decision, not a maintenance task.

## What the Rust runtime actually is (facts, cited)

- **A real, hardened crate, not a stub.** `software_factory/` is Axum + Tokio, ~2,686 lines of Rust
  across 38 tracked files, version `4.15.12` (`software_factory/Cargo.toml:3`; `docs/audit/CODEBASE-INDEX.md`).
  Its role is "high-throughput telemetry ingestion and transformation" (`README.md:30`).
- **Its own HTTP surface.** Port 8080, `POST /api/v1/telemetry/ingest`, `GET /api/v1/tenants/me`,
  `/health`, `/ready` (`README.md:34`, `README.md:91-92`).
- **Its own persistence.** Appwrite, with a real write path that was fixed after an earlier version
  logged "persistence completed" while writing nothing (`software_factory/src/services/appwrite_client.rs:27-34`).
- **Fail-closed.** It refuses to start without credentials (`software_factory/src/main.rs:13-24`),
  and the Gemini mock is opt-in behind `GEMINI_MOCK=1` and labelled `"mock": true`, so a fabricated
  answer cannot pass for inference (`software_factory/src/services/gemini_client.rs:34-58`).
- **Green in CI.** The `rust (fmt, clippy, tests)` job builds, formats, lints and tests it
  (`.github/workflows/verify.yml:180-205`), and the latest run on `main` reports **success**.

So the crate is not vaporware. Deleting it discards genuinely good, tested engineering.

## Its own tenant model — the second reason this is a decision

The Rust runtime **re-implements the tenant boundary independently** of the Node service:

- Rust: `TenantProfile { id, name, niche, tier, max_rpm, active }` and `IndustryNiche`
  (`software_factory/src/models/tenant.rs:3-28`); credentials from `TENANT_API_KEYS=tenant:key,...`
  parsed at startup (`software_factory/src/middleware/tenant_guard.rs:174-201`); the same
  `x-tenant-id`/`x-api-key` headers, a constant-time compare, and a deliberate 401-vs-403 split
  (`software_factory/src/middleware/tenant_guard.rs:13-15`, `:45-135`).
- Node: credentials from `FACTORY_TENANT_CREDENTIALS=tenantId:secret,...`, the same header names,
  and `403 TENANT_CREDENTIAL_MISMATCH` (`README.md:59-71`).

`README.md:26` states the position plainly: *"two services that enforce the same tenant model
independently."* There is **no shared source of tenant truth.** A tenant can be provisioned in the
Node service and absent from `TENANT_API_KEYS` — or vice-versa — and nothing errors, because each
service is the sole authority for its own credential map. That is a drift surface with no guard on
it today.

## Who owns it: nobody

The repository has said so, three sprints running:

- *"No second runtime. … Two live runtimes without one owner is the drift the Constitution forbids."*
  (`sprints/sprint-30-cloud-surface.md:52-54`)
- *"Rust runtime ownership"* sits in the parked list, named and not worked
  (`sprints/sprint-31-reproducible-workhorse.md:402`).
- The crate was to stay an *"optional high-throughput adapter until Rust tooling is installed in CI
  and its API contract tests exercise the same durable persistence and security boundaries"*
  (`sprints/sprint-08-founder-mode-runtime.md:29`).

## Is anything reaching it? No.

- **Not wired to the product.** No code path in `src/` or `server.ts` dials port 8080 or constructs a
  Rust client. The only references are log-label strings — `actorId: 'service:software_factory_runtime'`
  (`src/services/telemetryStore.ts:239`, `src/services/localTelemetryStore.ts:53`) — not calls.
- **Not published.** *"Never pushed to a registry and never deployed end to end"*
  (`docs/OPERATIONS.md:100`); the image archive is *"intentionally not committed"* and the registry
  gap is stated (`artifacts/README.md:18-32`).
- **Not declared as a capability.** `src/services/capabilityManifest.ts` lists every live/blocked
  capability; the Rust runtime is not among them. It appears only as context inside another entry.

## What it costs today — the demonstrated tax

Two recurring costs, both real:

1. **A lockstep version bump it has no reason to share.** A release must move five records in
   agreement (`package.json`, `package-lock.json`, `software_factory/Cargo.toml`,
   `software_factory/Cargo.lock`, `CHANGELOG.md`) — `AGENTS.md:56-58`, `scripts/verify-release.sh:6-9`.
   Two of those five exist only to keep a value with no relationship to a Node release in lockstep
   with it.
2. **A red gate on `main`, born of the coupling.** `software_factory/scripts/verify-k8s.py:163-183`
   requires the deployment image tag to equal the Node version in `package.json`. The release ritual
   bumps five records but **not** `software_factory/k8s/deployment.yaml`, which still pins
   `runtime:v4.15.6` (`software_factory/k8s/deployment.yaml:71`) while the product is `4.15.12`. The
   `kubernetes manifests` CI job therefore **fails**, and has failed on `main` since the v4.15.7
   release — five releases ago. The local release gate did not catch it: `scripts/verify-release.sh`
   does not run `verify-k8s.py`, so the ritual passed while CI stayed red. This is the exact
   false-confidence shape this repository forbids — a gate that passes while the real check fails.

The red gate is not the fault of the Rust crate. It is the fault of a *second* build/deploy artifact
being versioned as if it were the first. It is, however, the clearest evidence yet that "two runtimes
with one version" is actively costing correctness, not just tidiness.

## Options

### A. Archive — keep the source, remove it from the shipped path (**recommended**)

Stop treating `software_factory/` as a runtime the product ships. Keep the crate in the tree as
reference, but decouple it from the release:
- Supersede **ADR-003** with an ADR that records *why* (no owner, not deployed, a second tenant
  model, a release tax) and marks it **Archived**.
- Drop the crate from the release version lockstep (the five-record gate becomes four, or the Rust
  records are versioned on their own cadence) and from the required `verify` jobs.
- Remove the k8s manifests and the `publish.yml` `runtime` matrix entry from the *deployed* set (or
  move them under `archive/`), closing the red gate by removing its subject rather than feeding it.

- *Pros*: eliminates the recurring tax and the drift; resolves the "two live runtimes" ambiguity the
  Constitution forbids; preserves the code; fully reversible.
- *Cons*: a bounded one-time edit to ADR-003, the NC evidence rows that cite the crate
  (`docs/CONSTITUTION.md:127-131`), and the image/k8s gates — each a deliberate, reviewable change.

### B. Keep it, with a named owner

Claim it as a product surface and pay for it:
- Name the owner (in practice, the operator).
- Publish the image and pin a digest (`publish.yml` already builds it; `deployment.yaml:58-71`
  explains the digest pin), and either route telemetry to it or state plainly that it is a standalone
  runtime.
- Give the two tenant models one source of truth so provisioning cannot drift.

- *Pros*: keeps a green, hardened asset if real-time telemetry ingestion is a funded direction.
- *Cons*: ongoing parity cost for a service **no user reaches today**; the tenant-model duplication
  persists; the version/release coupling must be managed rather than removed.

### C. Delete

Remove `software_factory/` entirely.

- *Pros*: the smallest, cleanest tree; zero tax.
- *Cons*: supersedes ADR-003; invalidates the NC-4/NC-8/NC-9 evidence that cites the crate
  (`docs/CONSTITUTION.md:127-131`); removes the subject of 58 k8s checks and 25 image checks; throws
  away working code. Least reversible.

## Recommendation

**Option A: archive, do not delete.** The crate is real and hardened — deleting it discards genuine
engineering (C). But it is not a runtime the product runs, nothing reaches it, and it is now
actively costing correctness through a release coupling that has left `main` red for five releases.
Keeping it *without* reclassifying it (B) only preserves that cost for a service no user reaches.
Archiving ends the ambiguity, removes the tax, keeps the asset, and is reversible — the honest
reading of the repository's own rule that two live runtimes without one owner is the drift the
Constitution forbids. If the operator wants the minimal tree instead, C is the fallback; B is
justified only if telemetry ingestion is a funded direction with a user.

Whichever is chosen, one sub-decision should be settled at the same time: **`verify-k8s.py` must be
added to `scripts/verify-release.sh`**, so a manifest/version disagreement can never again pass the
local ritual and surface only as a red CI job.

## What is not claimed

This memo builds nothing and unblocks nothing on its own. It does not publish the Rust image, does
not route traffic to it, and does not delete or edit the crate, its manifests, or ADR-003. The red
CI gate described above is reported, not fixed — its fix depends on the decision above (Option A
removes its subject; Options B/C change it differently).

## Decision needed

Select exactly one:

- **A — Archive** (recommended): reclassify the crate as reference; supersede ADR-003; decouple it
  from the release and the deployed manifests.
- **B — Keep with an owner**: name the owner; publish and pin the image; unify tenant provisioning.
- **C — Delete**: remove the crate and its gates; supersede ADR-003.

A decision recorded here is the whole of WP-7. The execution it authorizes is a separate, sized piece
of work.
