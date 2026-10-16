# ADR-015: Horizontal scale requires a shared store, selected explicitly

- **Status**: Proposed (awaiting the operator's acceptance)
- **Date**: 2026-10-16
- **Resolves**: NC-2 — the decision, not the code. NC-2 stays open until an adapter lands.
- **Supersedes**: nothing
- **Relates**: ADR-001 (multi-tenant partitioning), ADR-009 (one storage backend, selected explicitly)

## Context

`docs/CONSTITUTION.md` Article III.3 requires the service to be horizontally scalable, stateless and
containerized; `NC-2` records that the TypeScript service is none of the first two. There are two
independent blockers, and each is sufficient on its own:

1. **The ledger is single-writer by construction.** `DurableStore` writes one JSON document atomically
   (temp file → `fsync` → rename → directory `fsync`) and is protected by a process-lifetime writer
   lock: a second process against the same data directory exits 75 rather than starting, because the
   adapter rewrites the whole file on every change and two writers would silently overwrite each other.
2. **The tenant registry is in-memory.** It is rehydrated from the durable ledger before the server
   listens (NC-1, resolved — a restart is safe), but two live replicas would hold two divergent
   registries of the same tenants.

This is a platform decision with a real cost, not a task to absorb quietly. It is recorded here so the
choice is reviewable, not made by momentum in a sprint. **This ADR proposes; it does not implement.**
The Constitution's Scope rule 2 means the status stays **Proposed** until the adapter that satisfies it
lands in the same change.

## The guarantee that must not be lost

ADR-009 chose the local ledger because it makes one narrow, real promise: **one writer process,
deterministic composite keys, and `409` on replay instead of a second row** — which is what makes
at-least-once delivery safe. A shared store must preserve the same three properties, at the store:

- **Idempotency at the storage boundary** (Constitution Article VI.4): a replayed request is rejected by
  a unique constraint in the database, never by an application check a future change could bypass.
- **Atomic multi-record writes**: the append-event-and-update-tenant pair either both land or neither
  does. This is the property ADR-009 found Appwrite lacking.
- **Fail-closed readiness** (Article III.4): an unusable or contended store prevents the process from
  serving, rather than being reported and served anyway.

## Options

### Option A — a relational store (PostgreSQL) as a new storage adapter — *recommended*

Add a third `TelemetryStore` adapter (ADR-009's port), storing rows in Postgres. The table set mirrors
today's 31 ledger collections; `tenants` and the event records get real foreign keys; an idempotency
key gets a `UNIQUE` constraint. Replicas become stateless: each reads the registry from the store.

- **Cost:** one managed Postgres (the operator's Coolify can host it), a schema + migration tool, and
  the ongoing ops of a database (backups, upgrades) — which is also Layer 3's durability work.
- **Migration:** additive and observable — define the schema, backfill from the JSON ledger, verify
  row counts per collection, then cut over through `STORAGE_BACKEND` (ADR-009's single switch). **No
  dual writes and no mirroring**: two stores that agree is a coincidence, not a guarantee.
- **Risk:** the migration is a discrete project; the 31-collection, versioned (`LEDGER_VERSION 8`,
  `MIN_LEDGER_VERSION 4`) schema must be mapped with the same additive-migration discipline.

### Option B — promote Appwrite to system of record

ADR-009 recorded the gaps that block this: no cross-row transaction spanning the tenant and event
rows, and a read path served from a write-populated cache, so a restarted process does not see rows an
earlier one wrote. Re-opening it requires ADR-001's consistency ADR **and evidence the gap has
closed**. If Appwrite's datastore now provides cross-row transactions, that changes ADR-009's premise
and must be recorded with a live probe — not assumed from a feature page.

- **Cost:** the least new infrastructure (the account exists), but the most new proof, and it reopens
  a settled decision.

### Option C — keep one writer, scale reads only

Run read-only replicas of a replicated ledger and keep a single writer. This relieves read load but
does **not** satisfy Article III.3's "horizontally scalable": write throughput and availability stay
bound to one process. It is a useful stopgap, not a resolution of NC-2.

### Option D — a distributed lock (Redis) in front of the JSON ledger

Rejected. It replaces a process-local lock with a network lock that has its own failure modes
(partition, TTL expiry, split brain) and still cannot make a whole-file rewrite atomic across
processes. It trades a known, tested single-writer guarantee for an untested distributed one.

## Recommendation

**Option A.** It is the only option that satisfies Article VI.4 (idempotency at the storage boundary)
and Article III.3 (stateless replicas) with a consistency model that can actually be asserted by a
test. Appwrite stays where ADR-009 put it — the multi-tenant SaaS adapter — until its own consistency
ADR exists.

The decision is the operator's, on the evidence, and it carries a cost (a database to run and back
up). Until it is accepted and the adapter lands, the shipped truth is unchanged: **one writer, one
replica**, and NC-2 stays open.

## Consequences

- NC-2 is not closed by this document. It closes in the change that lands the adapter and a test that
  two concurrent processes are rejected by the store, not the code.
- The process-lifetime writer lock (`exit 75`) is removed only once the store enforces idempotency.
- The `tenants` registry becomes a table read; the in-memory registry and its rehydration path are
  retired together with the file adapter, not before.
- A payments adapter (see `docs/WAVE-4-DECISION-MEMO.md`) is not buildable on a one-replica ledger.

## How this would be enforced (when built)

- `npm run verify:storage` gains a differential for the new backend, as it already has for local vs
  Appwrite.
- A test that two processes write the same idempotency key concurrently and the **store** rejects the
  second with the same `409`, never the application.
- Readiness refuses to serve when the store is unreachable, extending Article III.4's boundary.
