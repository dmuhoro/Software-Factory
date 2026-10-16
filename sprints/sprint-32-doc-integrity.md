# Sprint 32 — The Documents Match the Code

**Status:** WP-0 governance, WP-1 (known-limits gate) and WP-2 (doc-vs-code sweep) landed · **Opened:** 2026-10-16 · **Closed:** —

**Thesis.** Sprint 31 made the product reproducible and told the truth about the *capability* surface:
the capabilities table is generated from the manifest, so it cannot claim a capability the code lacks.
It did not make the *prose* true. The README's "Known limits" section and `docs/OPERATIONS.md` still
describe a system from several waves ago, and nothing checks prose against the non-conformance table.
This sprint closes that gap the way this repository closes every gap: with a gate that reads the claim
and the code, shown red before it is green. It also writes down the one decision the code cannot make
for itself (NC-2's shared store) and settles, one way or the other, whether Sprint 31's WP-7
measurement is worth building without a model.

Follows `docs/CONSTITUTION.md`, the ADRs in `docs/adr/`, `CONTRIBUTING.md`, and the cross-repo SOP.

---

## The finding that scoped this sprint

The constitution gate in `scripts/verify-docs.sh` proves the non-conformance table is internally
consistent — every resolved row has a commit, resolved and open rows sum to the total. It never reads
the README. So the exact drift it was written to catch (a non-conformance resolved by code and still
described as open by prose) can live one heading away, in the section a first-time reader trusts most.

At HEAD, `README.md` "## Known limits" made five claims; four were false, each falsified by a gate
that already existed:

| README claim | Reality | Proving command |
|---|---|---|
| "Provisioned tenants do not survive a restart" | The registry rehydrates from the durable ledger before the server listens (NC-1, `921ce52`) | `npm test -- test/l4-durable-tenancy.test.ts` |
| "The Docker image has never been built" | Both images build and are asserted against the artifact (NC-4) | `npm run verify:image` (25 checks) |
| "The k8s NetworkPolicy permits egress on 443 to `0.0.0.0/0`" | The wildcard is gone; egress is rendered from observed DNS (NC-5) | `npm run render:egress`; `software_factory/scripts/verify-k8s.py` |
| "The Rust runtime has no metrics endpoint" | `/metrics` serves Prometheus from the live router (NC-9) | `software_factory/tests/metrics_tests.rs` |

Only the fifth (in-memory registry ⇒ one replica) is still true, and it is true for a different reason
than the README gave: it is NC-2, horizontal scale, not restart durability. `docs/OPERATIONS.md` carries
the same rot in different rows — "137 tests across 20 files", "176 unit/integration", "a production
image has never been built and run" — stale counts and the same resolved image claim.

## Work packages

| WP | Objective | Proof | Status |
|---|---|---|---|
| **WP-0** | Governance: this sprint file | `npm run verify:docs` green; no production code | **done** |
| **WP-1** | Task 1 — reconcile README "Known limits" and add a gate that fails when a limit contradicts a resolved non-conformance | gate observed red on the old text (`uncited=5 NC-2-not-named`) and red on a planted `nc: NC-4` (`NC-4-claimed-open`), green after | **done** |
| **WP-2** | Task 2 — doc-vs-code sweep: every remaining stale figure or claim in a live doc corrected against the code, or listed as a lead | each corrected figure reproduced by a named command | **done** |
| **WP-3** | Task 3 — `docs/adr/ADR-015` (Proposed): NC-2's shared-store path — options, tradeoffs, cost, migration, recommendation; plus a Wave 4 decision memo | ADR-015 Proposed; a memo, not an implementation | **pending** |
| **WP-4** | Task 4 — decide whether the WP-7 benchmark harness is net-positive without a model; build it only if it is, else record why not | a named judgement with its reasoning | **pending** |
| **WP-5** | Task 5 — release: bump the five places + k8s, CHANGELOG, tag, push | `verify-release.sh` 13/13; `main == HEAD == tag^{commit}` | **pending** |

### Scope limits (hard)

- **No production behaviour changes.** This sprint edits documents, one gate script, and decision
  records. No service, route, schema or runtime is touched. A claim that needs code to become true is
  named as a lead, not worked around here.
- **No implementation of NC-2.** ADR-015 is a decision document marked **Proposed**. The shared store
  is a platform decision with a cost; it is the operator's to accept, not this sprint's to assume.
- **No WP-7 run against a real model.** No model is reachable (hosted: owner operator; local Ollama not
  running). Building a harness that cannot run is capability theater, the exact defect Sprint 31's
  WP-7 refused to commit.
- **No gate weakened to go green.** The new gate's rule set is fixed by the constitution's table; a
  disagreement is fixed by editing the claim, never the gate.

### Evidence plan

1. **The gate is shown red before green** — on the unmodified README, and on a planted contradiction.
   Both negative results are recorded in this file.
2. **Every corrected figure is reproduced by a command** in the same change (SOP rule 7).
3. **One concern per commit**, each leaving the tree green.
4. **Release discipline:** feature commits first, then one release commit (five version places +
   `CHANGELOG.md` + this file), annotated tag, push `main` and the tag, verify `main == HEAD == tag`.

## Named blockers (not worked around)

- **NC-2's shared store (owner: operator, via ADR-015).** Needs a store (Postgres/Redis/etc.), its
  consistency model, a migration, and a cost. Recorded as a decision; not implemented.
- **Wave 4 — payments + `CustomB2B` (owner: operator).** Held; the paused projects are
  credential-blocked. Recorded as a memo.
- **WP-7 measurement (owner: operator).** Unchanged from Sprint 31: no model reachable. This sprint
  only decides whether the harness is worth building before that changes.

## What this means for the ecosystem

When this sprint lands, the documents a newcomer reads are gated against the code that decides what is
true: the README's limits cannot claim a closed non-conformance, and the non-conformance table cannot
drift from the prose one heading away. The one decision the code cannot make — whether to buy a shared
store and trade the single-writer guarantee for replicas — is written down as a reviewable proposal
instead of hiding in a "Not scheduled" cell. What remains operator-blocked stays named with its owner.

## WP-0 — Governance

- This sprint file.

**Evidence:** `npm run verify:docs` green. No production code touched.

## WP-1 — Known limits reconciled and gated (Task 1, done)

`README.md` "## Known limits" rewritten so every line names its record and either the command that
shows it or the owner who unblocks it, and `scripts/verify-docs.sh` gained a section that reads that
prose and the constitution's table together.

- **The convention.** Every limit bullet carries a machine-readable provenance marker:
  `<!-- nc: NC-x -->` (an **open** non-conformance), `<!-- residual: NC-x -->` (what remains after
  `NC-x` was **resolved**), or `<!-- owner: <name> -->` (a limit that is not a recorded
  non-conformance).
- **The gate** (new section in `scripts/verify-docs.sh`, so it runs in `verify:docs`, `verify-full.sh`
  Layer 1 and the CI `docs` job without further wiring): every bullet cites a record; no `nc:` names a
  **resolved** non-conformance; no `residual:` names an open one; every open non-conformance is named.
- **Negative proof, observed, recorded.** On the unmodified README the gate is red —
  `uncited=5 NC-2-not-named` — and the gate was then planted with a resolved id (`<!-- nc: NC-4 -->`)
  and observed red again with `NC-4-claimed-open`, which is precisely the lapse it exists to catch.
  Both restored to green.
- **The four false claims replaced** with the truth and its proof: restart durability is proven by
  `test/l4-durable-tenancy.test.ts`; the image builds (`verify:image`); the egress wildcard is gone
  (`render:egress`, `verify-k8s.py`); `/metrics` is live (`metrics.rs`). Restart survives; the only
  real limit left from that bullet is NC-2, horizontal scale.

**Evidence:** `npm run verify:docs` **7/7** (was 6/6; the new section is the seventh). Negative results
recorded above.

## WP-2 — Doc-vs-code sweep (Task 2, done)

`docs/OPERATIONS.md` carried the same rot as the README, in other rows. Each corrected figure is
reproducible by a command named in its own cell.

| Where | Was | Is (reproduced by) |
|---|---|---|
| `OPERATIONS.md` §1 | "97 API routes" | **117** (`grep -cE '\b(router\|apiRouter\|v1)\.(get\|post\|put\|patch\|delete)\(' src/api/routes/*.ts`) |
| `OPERATIONS.md` §1 | "137 tests across 20 files, six defence layers" | **502 tests across 73 files**, plus the L1–L4 harnesses (`npm test`; `ls test/*.test.ts \| wc -l`; `npm run verify:layer1..4`) |
| `OPERATIONS.md` §3 Testing | "176 unit/integration … 7 end-to-end loop scenarios … a live run against a real local model (qwen2.5-coder:3b)" | **502 unit/integration across 73 files**, including the end-to-end loop suite (real git repos, stub model port). The unnumbered model-run claim was **dropped**: no command reproduces a historical run, and an unreproducible claim is not evidence |
| `OPERATIONS.md` §3 Deployment | "image never published … no published image and no digest pin" | Both images are **built and run as non-root** by `npm run verify:image`; never pushed to a registry and never deployed end to end; the manifest pins a **tag, not a digest** (`software_factory/k8s/deployment.yaml:71`) |
| `OPERATIONS.md` §3 Appwrite live | "key currently rejected (401)" | Scope split gated by `npm run verify:scopes`; probe is `npm run appwrite:check`; the live key state is an **operator fact**, not something the repo can assert |
| `OPERATIONS.md` §6 | "a production image has never been built and run. None has." | False: built and run by `npm run verify:image`. Reworded to the true residual — never **published or deployed** |
| `CONSTITUTION.md` NC-5 | "verify-k8s.py (57 checks)" | **58 checks** (`python3 software_factory/scripts/verify-k8s.py` → `58/58`) |

**Leads (named, not corrected — no command contradicts them, or they are citation drift):**

- `README.md` Verifying block claims `verify:layer1` **34**, `verify:layer2` **26**, `verify:layer3`
  **24** checks, and `cargo test` **15 tests**. Not reproduced in this sweep; a lead.
- Line-number citations drift by 1–2 lines: `OPERATIONS.md` cites `factoryJobService.ts:87` (the write
  loop is `:89`) and `telemetryStore.ts:1` (line 1 is a doc comment). Citation precision, not a false
  claim.
- `README.md` two-runtimes table says the registry "is in-memory": true, and now correctly qualified —
  it is rebuilt from the durable ledger on boot (NC-1, see WP-1).

**Evidence:** `npm run verify:docs` 7/7; `python3 software_factory/scripts/verify-k8s.py` 58/58;
`grep`/`ls` figures above reproducible.

