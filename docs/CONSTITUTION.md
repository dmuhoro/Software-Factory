# Software Factory Engineering Constitution

## Scope, Precedence, and Provenance

This document is the constitution **for this repository only**.

The execution-safety principles in Part Two are **adopted by reference** from a standard the
organisation already applies elsewhere. They are not restated here to become a second source
of truth, and this document does not claim authority over the repositories that own them.
Where a principle's canonical text lives elsewhere, the canonical text wins. See
`docs/portfolio/README.md` for the principle-to-repository index and the drift rule that
keeps the copies from diverging.

Two rules govern this document:

1. **It may not claim a protection the code does not provide.** That includes a claim about
   itself. Section "Known non-conformances" below records, with a date, every point at which
   this constitution is not yet satisfied by the implementation. A constitution that cannot
   record its own gaps is the failure mode Part Two exists to prevent.
2. **An amendment lands with the code that satisfies it, or with a dated entry in the
   non-conformance list.** An aspirational article with no implementation and no entry in that
   list is a false claim.

---

## Part One — Domain Invariants

### Article I: Tenant Partitioning & Zero Conflation
1. Every piece of business telemetry, database record, transformation ledger, and log MUST be partitioned by `tenant_id`.
2. Under no circumstance may context, credentials, encryption keys, or memory state be shared or conflated across tenant boundaries.
3. If an incoming payload specifies a tenant ID whose provisioned niche differs from the requested adapter, the runtime MUST immediately abort with `MALFORMED_CONTEXT`.

### Article II: Deterministic AI Transformation
1. All AI operations via Google Gemini MUST utilize strict structured output configurations (`responseSchema`).
2. Temperature MUST be capped at <= 0.1 for operational transformations to eliminate hallucination and schema drifting.
3. Every transformation must evaluate regulatory guardrails (e.g. Fair Housing non-discrimination, HIPAA PHI elimination, DOT cold-chain compliance) before returning success.
4. **Adopted 2026-09-29** — a transform whose downstream audit record cannot be stored MUST NOT report success. An event that is not recorded has not been processed. The TypeScript pipeline additionally bounds retried AI work by a wall-clock deadline; a retry budget without a time budget does not bound latency.

### Article III: Concurrency, Robustness, & Fail-Safe Design
1. The system must never fail silently. When payload validation or business rules fail, standardized error JSON must be returned: `{"status": "error", "code": "...", "message": "..."}`.
2. Downstream calls to AI APIs and Database layers must be guarded by Circuit Breakers with exponential backoff and jitter.
3. Microservices must be horizontally scalable, stateless, and containerized for automated Kubernetes orchestration. **See non-conformance NC-2: the TypeScript service is not horizontally scalable.**
4. **Adopted 2026-09-29** — a degraded dependency, an unusable ledger, or a contended writer MUST prevent the process from serving, not merely be reported. Readiness is a gate on serving, not a diagnostic.

---

## Part Two — Execution-Safety (adopted by reference)

Canonical source: `kays-wellness-centre/docs/engineering/CONSTITUTION.md`, Article I —
"Execution-Safety Guarantees". Reproduced here unchanged; if the two ever differ, the
canonical source governs.

**I.1 — Never let code claim a protection it does not actually provide.** False confidence
is worse than no protection. If an "evidence" gate, grep, or test can pass while the real
production path stays unguarded, the work is not done.

**I.2 — Enforcement goes at the real boundary.** Before wiring any guard into a tenant, money,
or submission path, read the actual code and find the true production path. Insert protection
there, not in a shared helper only the test or offline path uses.

**I.3 — Fail closed, never fail open.** Defaults must refuse, not silently allow. When unsure,
choose the conservative cap.

**I.4 — Proof must exercise the real path.** A unit test of a standalone service does not
prove wiring. Tests must assert that the actual production function is invoked, or refused, on
the real path.

**I.5 — Say no early, loudly.** If a plan has a flaw (wrong insertion point, false gate, scope
that contradicts its own constraints), say so explicitly and propose the corrected version
before executing.

**I.6 — No silent drops.** Rejections are explicit: the caller gets a clear reason, an audit
record, and a metric.

---

## Part Three — Delivery Discipline

### Article IV: Release and Provenance
1. **Every shipped change gets a release and a tag.** Never ship an upgrade that is untagged or unversioned. Never let a hotfix drift behind the last tag when it changes product behaviour. *(Adopted from `Daftari/AGENTS.md` § Release & Tagging.)*
2. **One product, one version.** The npm package, the crate, and the changelog MUST agree. `scripts/verify-release.sh` fails the build when they do not.
3. **Provenance footers on agent-authored commits.** Every commit containing meaningful agent-generated content MUST carry an `AI-Assisted:` footer, and MUST be reviewed by a human before push. *(Adopted from `afropay-network/AGENTS.md` § Provenance & Authorship.)*
4. **Version-control the shape, not the parameters.** The algorithm's structure belongs in version control; tuned constants, credentials, and per-tenant secrets MUST NOT. *(Adopted from `afropay-network/AGENTS.md` § Public Scaffolding, Private Parameters.)*

### Article V: Truthful State
1. **No fabricated data in any code path, including a metric.** A dashboard number that is hardcoded is a claim about the business. Hardcoded values in a code path are prohibited; if a value is not known, it is absent or explicitly a simulation, and a simulation is labelled as one.
2. **Documentation that contradicts the code is a defect.** A stale document is worse than a missing one, because it is trusted. When behaviour changes, the document describing it is part of the change.
3. **A claim of capability requires a command that demonstrates it.** "Implemented", "verified", and "production-ready" each require a named check and its output. Where verification was impossible in the available environment, the documentation says so instead of implying coverage.
4. **Honest zero beats false representation.** Where traction is absent, say so.

### Article VI: Dependency, Type, and Arithmetic Discipline
1. **No new production dependency without recorded justification**: what it replaces, its bundle or supply-chain impact, its maintenance status, and the alternative considered. *(Adopted from `Daftari/ai-context/architect.md` Law 5.)*
2. **No unbounded `any`, no `as unknown as X`, and no non-null assertion outside justified tests.** Unsafe casts move a compile error into production. *(Adopted from `Daftari/ai-context/architect.md` Law 4.)*
3. **No floating-point arithmetic on any monetary or quota quantity.** Use integer minor units or an arbitrary-precision decimal. Binary floating point cannot represent `0.10` exactly, so repeated accumulation of money diverges. *(Adopted from `afropay-network/AGENTS.md` § Arbitrary Precision Safe Decimal Math.)*
4. **Idempotency is enforced at the storage boundary**, by a unique constraint on the idempotency key, not only in application logic. A replayed request must be rejected by the database, not by a code path a future change could bypass. *(Adopted from `afropay-network/AGENTS.md` § Idempotency Guarantee.)*
5. **Any new outbound integration passes through a single provider abstraction.** No file outside that package may import a vendor SDK directly, so a provider can be swapped and its surface audited in one place. *(Adopted from `afropay-network/AGENTS.md` § Vendor Independence.)*

### Article VII: Evidence and Test Integrity
1. **Never weaken or delete a test to make a build pass.** A green suite means the code is correct, not that the assertions were removed. *(Adopted from `kays-wellness-centre/AGENTS.md` § 4.)*
2. **A passing count must never imply a known defect is resolved when it is not.** *(Adopted from `kays-wellness-centre/AGENTS.md` § 9.)*
3. **A new test must be shown to fail without its fix.** A test that cannot fail is not evidence. Each security gate in this repository is verified by reverting the fix and observing the failure, and that verification is recorded in the sprint record.
4. **Gates that enforce a rule are preferred to prose that asserts one.** A rule that a build can check does not rot; a rule in a comment does. Where a rule is stated above and a check exists, the check is the enforcement.

---

## Known non-conformances

Recorded per the Scope rule. Each is a claim this document makes that the code does not yet
satisfy. **Removing an entry requires the code that resolves it, in the same change.**

Open entries:

| ID | Article | Non-conformance | Recorded | Resolves in |
|---|---|---|---|---|
| NC-2 | III.3 | The TypeScript service is not horizontally scalable: a single-writer JSON ledger and an in-memory registry. It MUST run exactly one replica. | 2026-09-29 | Not scheduled — requires a shared store, tracked as a platform decision |
| NC-3 | VI.1 | `package-lock.json` and `bun.lock` are both tracked; two lockfiles is an unreconciled dependency policy. | 2026-09-29 | Wave 3 |
| NC-4 | V.3 | The Docker image has never been built. Non-root execution and absence of secrets are verified by inspection only. | 2026-09-29 | Wave 5 |
| NC-5 | III.3 / V.3 | The Kubernetes egress policy permits 443 to `0.0.0.0/0`. | 2026-09-29 | Wave 5 |
| NC-8 | I.4 | A `CustomB2B` tenant is routed to the real-estate adapter, so a non-real-estate tenant is validated against the wrong rules. | 2026-09-29 | Wave 4 — **held for decision** |

### Resolved

Retained as an audit trail, because a non-conformance that is silently deleted is
indistinguishable from one that was never recorded.

| ID | Resolved in | By | Evidence |
|---|---|---|---|
| NC-1 | `921ce52` (Wave 1) | The registry is hydrated from the durable ledger before the server listens, and every mutation writes through. `TenantService.bootstrap` rehydrates; `DurableStore` carries the `tenants` collection at ledger v5. | `test/l4-durable-tenancy.test.ts`; `scripts/verify-layer4.sh` L4-1..L4-6 (restart with tenants intact) |
| NC-6 | `921ce52` (Wave 1) | A credential naming an unknown tenant is a startup failure. `server.ts` refuses to serve and the harness asserts the process exits non-zero. | `scripts/verify-layer4.sh` L4-7 |
| NC-7 | `921ce52` (Wave 1) | `server.ts` deletes each plaintext entry from the runtime config immediately after installing its digest. The comment states the honest limit: the bytes are no longer collectable through the object, and are not zeroized. | `scripts/verify-layer4.sh` L4-9 |
| NC-9 | Wave 2 | `software_factory/src/metrics.rs` serves a real Prometheus exposition at `/metrics` from the live router. | `software_factory/tests/metrics_tests.rs`; live-binary scrape; four recorded negative controls |

**Process note.** NC-1, NC-6 and NC-7 were resolved by `921ce52` but left in the open table,
which is the exact failure the Scope rule exists to prevent: this document claimed four
non-conformances that the code no longer had. They are removed here, in the first change after
the one that resolved them, and the gap is recorded rather than hidden.

