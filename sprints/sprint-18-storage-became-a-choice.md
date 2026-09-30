# Sprint 18: the backend became a choice

- **Status**: Complete
- **Date**: 2026-09-30
- **Precedes**: `sprint-17-appwrite-actually.md`
- **Branch**: `review/appwrite-pilot-4.8.0`

## The problem this sprint inherited

Sprint 17 proved Appwrite worked. It did not prove the product used it.

`AppwriteService` was named for Appwrite and never called it. It wrote to the local
`DurableStore`, which meant the repository had two persistence stories, no ADR, and no test
that could tell them apart — the class name promised one thing and every call site did another.
The decision had never been made. It had been hidden by the naming.

Worse, everything Sprint 17 proved sat *beside* the request path. The scripts drove the SDK
directly. Nothing asserted that an actual HTTP request was written by the backend the operator
selected. A deployment could have printed `Appwrite` in its startup banner and written to a
laptop's disk, and every test would have stayed green.

## What landed

**The seam.** `TelemetryStore` is the port; `LocalTelemetryStore` and `AppwriteTelemetryStore`
are the adapters. Exactly one is active per process, chosen by `STORAGE_BACKEND`, which accepts
only `local` or `appwrite`. No fallback, no mirroring, no dual write. An unrecognised value stops
the process with a named reason. ADR-009 records why Appwrite is an adapter and not the system
of record: it has no foreign keys and no multi-document transaction spanning tenant and event,
so the local ledger's consistency guarantee does not transfer automatically.

**The proof.** `scripts/verify-storage-backend.sh`, wired into CI and `verify:release`. The
load-bearing check is differential: the same request, from the same tenant, goes to a real server
twice. The tenant exists in the local registry and not in the Appwrite tenants table, so local
accepts and Appwrite refuses with `TENANT_NOT_ONBOARDED`. Identical input, opposite outcome. A
label on a banner cannot produce that, so the assertion cannot be satisfied by configuration.

**A hole found while doing it.** `telemetry_events.tenantId` is a plain column. The live probe
demonstrates the table accepting an orphan row for a tenant that does not exist — well-formed,
passes every shape check, refers to nothing, and no later read would surface it. The store now
refuses. The e2e script's header had been *claiming* that protection since Sprint 17 while
nothing tested it and nothing enforced it; the claim was the defect, and both halves are now
asserted. Live e2e went 7/7 → 9/9.

## Three of my own errors, all the same shape

Every one was a check measuring the wrong thing, and every one would have passed anyway.

1. `$ROOT` was used but never assigned in the new gate. Under `set -u` that aborted the script.
2. The gate started the child server from the repository, so `dotenv/config` loaded the
   developer's `.env`, which sets `ALLOW_INSECURE_LOCAL=true`. The server then correctly refused
   to boot in production — a correct refusal aimed at the wrong target.
3. Model keys leaked the same way, so the local-mode result depended on whether the operator
   happened to have one exported. The child environment is now pinned explicitly.

`set -u` was left on. An unbound variable in a verification script must abort loudly rather than
expand to empty and turn a check green.

## The same defect in two more places

Wiring the gate exposed a class of problem that had been in the repository all along.

`npm test` passed on one machine and failed on another from the same commit. The cause was the
repository `.env`: it sets `FACTORY_WORKTREE_ROOT=/approved/worktrees`, and the level-2-4 tests
pinned `FACTORY_DATA_DIR` and `FACTORY_WORKSPACE_ROOT` to temp directories but never that one. On
a machine that could not create `/approved`, the suite failed with `EACCES`; on one that could,
it passed.

All four layer harnesses then failed the same way, with the server correctly refusing
`ALLOW_INSECURE_LOCAL=true` inherited from the shell that launched them.

A green suite that is green because the environment cooperated is not evidence. A red suite
caused by a stray export sends the next person hunting a phantom. `test/setup-isolate-env.ts`
and `scripts/verify-env.sh` now make both hermetic, and both pass with the `.env` sourced and
unset, on repeated runs. The test prelude is loaded by the test script only — silently rewriting
an operator's configured paths at product startup would be worse than the problem it solves.

## Evidence

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm test` | 123/123, with `.env` sourced and unset |
| `verify:layer1` … `verify:layer4` | pass, with `.env` sourced and unset |
| `npm run appwrite:e2e` (live) | 9/9 |
| `npm run verify:storage` | 5/5 |
| `npm run verify:storage:live` | 8/8 |
| `npm run verify:secrets` | pass |
| `npm run verify:docs` / `:integrations` / `:image` | pass |
| `npm run verify:release` | 13/13 |

The new tenant-refusal test was verified to fail with the check removed, so it is a real control
and not a passing assertion.

## Commits

- `8324fed` `feat(storage): make the backend a choice, not a class name`
- `e4849ff` `fix(test): make the suite hermetic, so it stops measuring the operator's shell`
- `3b0f17e` `feat(storage): gate the seam, and prove the selection reaches a real request`
- `8cabbd0` `fix(verify): stop the layer harnesses inheriting the developer's shell`

## Open, deliberately

- **The Appwrite read path is cache-backed.** It is populated by writes, so a restarted process
  does not see rows written by an earlier one. This is why Appwrite is still an adapter, and it
  is written down in ADR-009 rather than left to be discovered. Fixing it needs its own ADR.
- **NC-2 stays open.** Multi-replica writes are unsolved. Neither backend closes it: the local
  ledger is single-process, and Appwrite's row-level isolation does not give this schema the atomic
  multi-row write a replica-safe design needs.
- **`ALLOW_INSECURE_LOCAL` and the model-key path** are now exercised hermetically but are not
  otherwise in scope for this sprint.
