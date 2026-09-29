# ADR-005: An Unserved Niche Is Refused, Never Approximated

## Status
Accepted — 2026-09-29

## Context

`IndustryNiche` has four variants: `real_estate`, `healthcare`, `logistics` and `custom_b2b`.
Three have implemented adapters. The fourth does not.

Both runtimes nonetheless served all four, and both did so by quietly substituting a neighbour:

- **Rust.** `get_adapter` returned `Box<dyn NicheAdapter>` unconditionally. The `CustomB2B`
  arm returned `RealEstateAdapter`. A B2B event was therefore normalized as though it were a
  property: `squareFootage` defaulted to 2400, a missing `listPrice` produced a
  `normalizedPricePerSqFt`, and the response named
  `Fair Housing Act Non-Discrimination Filter` among the guardrails applied.
- **TypeScript.** `NicheAdapterService.processAdapter` had a `default:` branch that returned
  `isCompliant: true` with `guardrailsApplied: ['Standard SOC2 Logging']`, having evaluated
  nothing. The payload was echoed back untouched.

The TypeScript case is the more serious of the two, and it is worth stating precisely why.
It did not merely return the wrong shape; it returned a **compliance verdict**. A tenant
integrating against this service would have accumulated SOC2 evidence in their own records
that this service manufactured. The artifact was shaped exactly like real evidence — a status,
a verdict, a list of controls — and the only trace that no control had run was that the
guardrail list contained one generic entry instead of a specific one.

Two further claims made the gap invisible rather than loud:

- `factory.routes.ts` advertised `supportedNiches: [..., 'custom_b2b']` in the metrics
  endpoint, so an operator reading live metrics was told a capability the pipeline could not
  deliver.
- `NICHE_REGISTRY` carried no notion of operational status, so a niche with no
  implementation looked identical to one with a full implementation.

This is recorded as NC-8, and it sits directly against the constitution's rule that a system
must never claim a protection it does not provide. The two behaviours are the same defect
seen from two directions: the Rust side invented a guardrail that did not run, the
TypeScript side invented a verdict that was not earned.

The decision taken was **fail closed**: refuse the niche explicitly, with no payment or
generic-adapter implementation attempted in this wave.

## Decision

1. **`get_adapter` returns `Result<Box<dyn NicheAdapter>, AdapterError>`.** A niche with no
   implemented adapter is an `Err`. The signature change is the control: a selector that can
   return `Box` unconditionally cannot express "no adapter exists", and that is why the
   defect was possible.
2. **`AdapterError::NicheNotServed` is a distinct variant**, not a string inside
   `MalformedContext`. "Your payload is wrong" and "we do not serve your industry" demand
   opposite responses from a caller, and collapsing them would send an integrator into a
   debugging loop over a payload that was entirely correct.
3. **The Rust refusal happens before any payload field is read** and before any model call, so
   a refused tenant incurs no cost and no data is interpreted in the wrong regulatory frame.
4. **The TypeScript `default:` branch refuses** via `emitNicheNotServedError`, and the
   fabricated `isCompliant: true` result is deleted rather than amended.
5. **`NICHE_NOT_SERVED` is registered in the public error table with status 403** and a fixed
   message. Not 400 — the caller's payload is correct. Not 501 — this is a product boundary,
   not an absent implementation detail, and 501 invites a retry that can never succeed. The
   published message must not echo caller data and must not enumerate the served niches,
   which would be an invitation to probe the boundary.
6. **The niche stays in the registry, marked `operational: false` with a stated
   `unavailableReason`.** Hiding it would make the platform look more capable than it is;
   leaving it unmarked is what caused this. `GET /api/v1/schemas/niches` and
   `GET /api/v1/schemas/gemini` both surface operational and unavailable sets, and
   `supportedNiches` in the metrics endpoint is now derived from the registry rather than
   hardcoded, so the two cannot drift apart again.
7. **The refusal carries a code prefix (`NICHE_NOT_SERVED:`) into logs**, so the refusal is
   diagnosable from a log line without reading the request.

## Consequences

### Positive
- A `custom_b2b` tenant now receives a truthful 403 with a stated reason instead of a
  confident, wrong answer. The failure is loud, specific, and attributable.
- No compliance verdict is ever asserted for a control set that was not evaluated.
- `operational` makes the difference between "works" and "answers plausibly" machine-readable,
  so future gaps are visible in the API rather than discovered in an integration.
- `supportedNiches` can no longer drift from reality, because it is derived from the same
  registry that describes the adapters.

### Negative
- `custom_b2b` tenants are **out of service**. This is a real revenue and integration cost,
  accepted deliberately: the alternative was serving them incorrectly.
- Enabling the niche now requires genuine work — a tenant-specific control set — rather than
  the previous one-line default branch. This is the intended cost. A generic B2B compliance
  claim cannot be written without knowing the actual controls, and writing one would recreate
  the original defect in a new file.
- Three new files of tests exist to protect a refusal. That is deliberate: a refusal is easy
  to "simplify" away, and these tests are what make the simplification fail.

### Neutral
- The `NicheAdapter` trait now requires `Debug`. This was added so
  `Result<Box<dyn NicheAdapter>, _>` can be asserted on and logged; without it, callers
  holding a success value are pushed into `unwrap`-shaped code, and the refusal branch is
  exactly the one that must not be dropped.

## Verification

- `test/l5-niche-refusal.test.ts` — 6 tests, including an assertion that the refusal leaks no
  compliance claim and no caller data.
- `software_factory/tests/niche_refusal_tests.rs` — 4 tests, including that the three served
  niches still resolve correctly and that the refusal message carries no tenant identifier.
- Negative controls, each reverted and each observed to fail: restoring the
  real-estate mapping in Rust fails 3 of 4 Rust tests; restoring the fabricated-compliance
  `default:` branch in TypeScript fails 2 of 6 TypeScript tests, including the one that
  detects the manufactured compliance verdict specifically.
- An existing contract test, `L3: every path-guard boundary code has a status and a written
  message`, failed on the first run of this change because `NICHE_NOT_SERVED` was not yet in
  the public error table. It was not modified to accommodate the new code; the code was
  registered.
