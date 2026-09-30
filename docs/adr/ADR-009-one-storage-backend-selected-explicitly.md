# ADR-009: One storage backend per process, selected explicitly

- **Status**: Accepted
- **Date**: 2026-09-29
- **Resolves**: the decision hidden behind a class name
- **Supersedes**: nothing

## Context

`AppwriteService` was named for Appwrite. It never talked to Appwrite. It called `DurableStore`,
a local, single-process, write-through JSON store with an in-memory cache.

That mismatch was not cosmetic. It meant the repository had two persistence stories, no ADR, and
no test that could tell them apart, because the class name promised Appwrite and every call site
did the same local thing. The decision had never been made — it had been hidden by the naming. Any
reviewer reading `AppwriteService.recordTelemetryEvent(payload)` had every reason to believe
tenant data was in the cloud.

The Appwrite integration then made this worse rather than better. A real client, a real project,
a real schema and a real end-to-end test all landed, and all of them sat *beside* the request path
rather than in it. The proof scripts exercised the SDK directly. Nothing asserted that an actual
HTTP request was written by the backend the operator selected. A deployment could have printed
"Appwrite" in a banner and written to a laptop's disk, and every test would have stayed green.

## Decision

Persistence is a port. `TelemetryStore` is the interface; `LocalTelemetryStore` and
`AppwriteTelemetryStore` are the two adapters. Exactly one is active per process, chosen by
`STORAGE_BACKEND`, which accepts only `local` or `appwrite`.

The consequences are the point:

- **No fallback.** There is no "try Appwrite, and if it throws, use the disk". A silent fallback
  means a request is accepted against storage nobody is monitoring, and the mismatch surfaces as
  data loss reported by a customer rather than by an alert.
- **No mirroring, no dual writes.** Two stores that agree is not a guarantee. It is a coincidence
  that has not been tested yet, plus a second consistency problem to reason about forever.
- **Fail at startup, not on the first request.** An unrecognised `STORAGE_BACKEND` stops the
  process with a named reason. A deployment typo must be a refusal to boot, not a quiet downgrade.
- **The banner states the truth.** The active backend is printed at startup, so an operator can
  verify what is running without reading source.

`AppwriteService` is retained as a facade over the selected store so that the 30-odd existing
call sites did not each need to learn the selection. It is a delegation shim, not a second
implementation, and it is named for what it does rather than for a vendor.

## Why Appwrite is an adapter and not the system of record

Not because it is a weaker database. Because a system of record is a consistency claim, and
Appwrite does not currently let us make the one this product needs.

The local ledger's guarantee is narrow and real: one writer process, deterministic composite keys,
and `409` on replay instead of a second row. That is what makes at-least-once delivery safe here.

Appwrite offers no foreign keys — the live probe demonstrates this by writing an orphan row
successfully — and no multi-document transaction spanning the tenant row and the event row. So
the guarantees do not transfer automatically. Promoting it to system of record would mean
claiming an integrity property we have not measured, which is the failure this repository exists
to prevent.

The tenant check is therefore in the *store*, not the table, and the e2e test asserts both halves:
that the raw table accepts an orphan, and that the store refuses one. Anyone who later removes
the check will find a failing test explaining why it was there.

## Consequences

- Two backends means two code paths, and both are gated. `npm run verify:storage` asserts a typo
  stops the process, the banner names the backend, and an authenticated request is served.
- The Appwrite read path is currently served from a cache populated by writes, so a restarted
  process does not see rows written by an earlier one. This is a **known, recorded gap**, not a
  hidden one, and it is the reason Appwrite is still an adapter.
- Reads must become datastore-backed before any promotion decision, and that work needs its own ADR.
- `NC-2` (multi-replica writes) stays open. Neither backend closes it; the local ledger is
  single-process only, and Appwrite's row-level isolation does not give this schema the atomic
  multi-row write that a replica-safe design needs.

## How this is enforced

`scripts/verify-storage-backend.sh`, wired into `npm run verify:release`.

The load-bearing check is differential. The same request, from the same tenant, is sent to a real
server twice: once with `STORAGE_BACKEND=local` and once with `STORAGE_BACKEND=appwrite`. The
tenant exists in the local registry and not in the Appwrite tenants table, so the local backend
accepts and the Appwrite backend refuses with `TENANT_NOT_ONBOARDED`. Identical input, opposite
outcome. A label on a banner cannot produce that, so the assertion cannot be satisfied by
configuration alone.
