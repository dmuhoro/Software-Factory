# Sprint 19: the gates that were not running

- **Status**: Complete
- **Date**: 2026-09-30
- **Precedes**: `sprint-18-storage-became-a-choice.md`
- **Branch**: `review/appwrite-pilot-4.8.0`

## The problem this sprint inherited

Sprint 18 ended with a green suite and a claim that CI was enforcing it. Four of those gates
never ran. The pattern was the same in each case: a gate whose *assertion* was written by the
same person, in the same sitting, as the code it was supposed to check, and which was verified by
reading it rather than by watching it reject something.

**`.github/workflows/integrations.yml` could not run at all.** It gated every job with a
`secrets.*` reference inside a job-level `if`. GitHub rejects that outright — the `secrets`
context is not available when the job itself is being decided. Every run failed in under a
second with zero jobs executed. CodeRabbit had never reviewed a single commit on this repository,
and the workflow meant to prove it was active was asserting the exact defect that stopped it
running.

**The Appwrite read path was a cache.** Reads were served from a per-process in-memory map, so a
restarted server reported an empty history while the rows sat in the database. The tests passed
because the cache was consistent with itself. Reverting the fix fails five read-path tests, which
is the only reason to believe the tests were ever testing anything.

**The health check misdiagnosed its own failure mode.** It advised exporting
`APPWRITE_API_KEY` for a variable that *was* exported. It had one failure bucket, and the advice
was written for the most common cause regardless of what actually happened.

**Nothing was publishable.** `k8s/deployment.yaml` pointed at a `gcr.io` image tag that had never
been pushed, so a deployment of this branch would have pulled nothing and failed at pull time.

## What landed

**A gate that fails closed on its own key.** `AppwriteFailureKind` classifies the failure as
`not-configured`, `unauthorized`, `forbidden`, `not-found`, `network` or `not-provisioned`, and
each carries its own operator advice. A configured-but-refused key is never told to export a
variable it already has. Seven tests, one per cause, because a classification that cannot tell
these apart is a guess.

**The CI gate that rejects the bug it exists to catch.** `scripts/verify-integrations.sh` now
fails on *any* job-level `secrets.*` reference in any workflow. Its negative control plants the
original defect and the gate catches it; with the defect present it reports five failures, with it
absent, sixteen checks pass. `actionlint` is now a CI job, and it is what found the
`matrix.image.name` → `matrix.name` bug in the publish workflow.

**Datastore-backed reads.** Async read contracts across store, facade and routes;
`tables.listRows` with the tenant predicate pushed into the query, newest-first, default limit
100 and a hard maximum of 500. Corrupt JSON becomes `LEDGER_UNAVAILABLE` rather than a crash. A
fresh-instance test proves a row written before a restart is readable after it, which is the
assertion the cache could never have satisfied.

**The least-privilege scope split, enforced.** Appwrite creates keys with an empty scope set, and
an empty scope set is refused on every data-plane call with a 401 indistinguishable from a wrong
project. Scanning the code for what it actually calls yields two sets: a runtime key
(`databases.read`, `rows.read`, `rows.write`) and a wider, separate provisioner key. The runtime
key deliberately cannot write schema, because it sits in every server process and
`tables.write` on a shared-tenant database is not a risk worth taking.
`scripts/verify-appwrite-scopes.sh` keeps that true.

**Getting that scope gate honest took four corrections, each found by running it.**
Scanning `src/` flagged a code *sample* rendered in `src/App.tsx`'s `<pre>` block. A bare
`indexes\.` matched the sentence "the knowledge base indexes". The runtime block was extracted
with `awk` on a lowercase marker while the file says "The", so it was always empty and the check
passed without reading anything — permanently, and vacuously. And the block was then matched as
prose, flagging the sentence listing the scopes the key must *not* have — which would have
pressured someone to delete the warning that keeps the key narrow. A gate that cries wolf on
documentation gets switched off, and a switched-off gate protects nothing.

**One command, in dependency order.** `npm run verify:full` runs four layers — static, tests,
local storage contract, live Appwrite — and distinguishes a configured-and-working integration
from a configured-and-broken one, which fails, from an unconfigured one, which skips. A
configured-but-broken integration reported as SKIP would be this repository's original sin in a
new coat.

**Two secret-handling defects.** `set-secret.sh` discarded a piped value that had no trailing
newline — `read` returns non-zero for that and for a bare Enter, which mean opposite things. And
its refusal message printed the argument back, so pasting a key where a variable name belonged
leaked the entire key to the terminal, scrollback and any screen share. The validation was right;
the error handling was the leak. `scripts/verify-argv-leak-control.sh` now runs the handler with a
credential-shaped argument and asserts no part of it reaches the output — six checks fail
against the previous version.

**The operator check loads `.env`.** `npm run appwrite:check` reported `api key: (unset)` on a
machine with a complete, correct `.env`, because it read `process.env` only and worked solely for
whoever remembered to `set -a && . ./.env` first. It reported absence when the thing was present,
which is the worst shape of bug in an operator tool: it is indistinguishable from the failure it
claims to detect.

## Evidence

- `npm run verify:full` — 12 checks, 11 green, 1 red (the Appwrite 401 below), 3 skips with
  reasons stated.
- `npm test` — 137/137.
- `npm run verify:integrations` — 16/16, with a 5-failure negative control for the job-level
  `secrets` defect.
- `npm run verify:secrets:argv` — 6 failures against the leaking handler, all pass against the
  fix.
- `npm run verify:scopes` — 7/7, with three negative controls observed rejecting a server-side
  migration, an over-granted runtime key, and the removal of the 401 advice.

## What this sprint did not fix

**The Appwrite key is still rejected.** Live verification is blocked on one action in the console:
grant the key `databases.read`, `rows.read`, `rows.write` in project `6aaa99700007bd53480e`.
Nothing in code is wrong. `npm run verify:full` correctly reports this as a failure rather than a
skip, which is the intended behaviour.

**The image has still never been published.** The workflow exists and is lint-clean; no tag has
been cut, so no image exists. `gcr.io` is now `ghcr.io` in the manifest, and the package
namespace in the workflow needs reconciling with the path the manifest requests before a first
publish.

**The agent still does not act.** This is the largest gap in the product and it is not a
sprint-sized fix. `agentExecutionService.ts:11` fails every job with
`PROPOSAL_REQUIRES_TOOL_APPLIER`, and nothing applies a model proposal to disk. The
control plane is real; the actuation layer is not built. See `docs/OPERATIONS.md` for the design
constraint that must survive that build.
