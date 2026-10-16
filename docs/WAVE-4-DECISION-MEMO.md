# Wave 4 decision memo — payments and a generic `CustomB2B` adapter

- **Status**: **HELD** — a decision for the operator, not a sprint to start
- **Date**: 2026-10-16
- **Owner**: operator
- **Source of record**: `docs/portfolio/SOP.md` § "Standing portfolio decisions (open)"

## What Wave 4 is

Two capabilities, bundled because they share a precondition:

1. **A payments adapter.** An in-product payment rail (charge, refund, reconciliation) behind the
   single provider abstraction (Constitution Article VI.5) — never a vendor SDK outside that package.
2. **A generic `CustomB2B` niche adapter.** A schema, adapter and acceptance tests for the
   configurable B2B niche that today refuses (NC-8 resolved: an unserved niche is refused, not
   approximated — ADR-005).

## Why it is held

- **It is the only wave whose value is not yet established.** Every other wave shipped a capability
  the repository could prove; this one cannot point at a user who needs it.
- **The two paused projects are blocked on owner-held credentials, not on missing adapter
  capability.** Building the adapter would not unblock them; the credential would.
- **A payments adapter without a payments rail is a well-typed placeholder.** It would move money
  nowhere and pass its tests, which is the exact shape of a false claim this repository forbids.
- **`CustomB2B` must keep refusing** until an ADR defines its schema, adapter and acceptance tests.
  `NICHE_REGISTRY` marks it non-operational on purpose (ADR-005).

## Decision needed

Select exactly one, on the evidence:

- **Accept** — the operator supplies the preconditions below and the wave becomes a sprint.
- **Reject** — payments and a generic B2B adapter are out of scope for this product; the niches stay
  refusing and no money is ever held.
- **Defer with a trigger** — name the event that reopens it (for example: "a signed customer for the
  B2B niche", or "a chosen PSP account"). A deferral without a trigger is a silent drop.

## Preconditions before any build

1. **A payments rail** — a chosen provider and its credentials, held by the operator. No rail, no
   adapter.
2. **Money arithmetic is integer minor units** (Constitution Article VI.3; Daftari Law 2). No
   floating point on any monetary quantity, ever.
3. **Idempotency for payment state at the storage boundary** (Article VI.4) — a unique constraint on
   the idempotency key in the store, not an application check.
4. **ADR-015 accepted.** A payments adapter on a single-writer, one-replica ledger is a one-replica
   payments system; the shared-store decision comes first.
5. **A niche ADR for `CustomB2B`** — schema, adapter, acceptance tests, before it stops refusing.

## What is not claimed

No payments code exists. No `CustomB2B` adapter exists. This memo records a decision and its
preconditions; it builds nothing and unblocks nothing on its own.
