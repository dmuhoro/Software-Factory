# ADR-012: Learning from run outcomes is bounded, deterministic, and off by default

- **Status**: Accepted (Sprint 29, WP-6 — implemented as `LearningDigestService`, injection off by default)
- **Date**: 2026-10-14
- **Resolves**: the missing read-back from the factory's own recorded runs (the one genuine gap in
  the Google-AI "recursive self-improvement" proposal)
- **Supersedes**: nothing

## Context

The factory records everything the loop does and never reads it back.

- The loop writes a durable record per run: `executionLoopService.ts:257-259` (`listRuns`), `:932`
  (`runId = looprun_<sha24>`), `:962` and `:1002` (upsert). The shape is `LoopRunRecord`
  (`loopTypes.ts:95-125`): `status`, per-unit `attempts` each carrying `stage`, `reason`, `detail`
  (`:30-52`), `gates` (`GateResult`), `commits`, `merges`, `hardStop`, `refusal`,
  `narrationRejected`.
- `OutcomeService` records business outcomes — `ADOPTION`, `TIME_SAVED`, `DEFECT`, `INCIDENT`,
  `LEARNING`, with `reusablePatterns` and `decisionsToAvoid` (`outcomeService.ts:3-8`).
- **Nothing reads either collection into planning.** `GoalIntakeService` drafts from a file
  inventory only (`goalIntakeService.ts:104-116`); `IssueIntakeService` reuses the same
  `draftTaskDocument`. A run that failed the same way five times starts a sixth run that will fail
  the same way, with no record of that shape reaching the drafter.
- Failure classification exists for factory **jobs** (`verificationProfileService.classifyFailure`,
  `FailureClass`) but the loop run record has no `failureClass` and no cross-run summary
  (Sprint 29 WP-3 adds the per-run half).

A Google-AI "civil-engineering doctrine" chat proposed this as *recursive self-improvement*:
feed past failures back into task generation, autonomously. The audit's verdict is that the
**gap is real** and the **autonomy framing is not admissible** — it collides with Constitution
Article V.1 (no fabricated data), V.3 (a claim needs a demonstrating command), and Part Two
(irreversible actions stay human-reviewed). This ADR keeps the gap and refuses the framing.

## Decision

**1. The ledger is the only source of truth.** A learning digest is derived exclusively from
durable records the factory actually wrote (`factoryLoopRuns`, and optionally `outcomes`). A
failure that was not recorded cannot be learned from; the digest says so rather than inferring it.

**2. Deterministic.** The digest is a pure function of the ledger contents: no LLM, no clock, no
randomness. The same ledger yields a byte-identical digest. Entries are ordered by
(count descending, then key ascending) so ordering is stable.

**3. Bounded.** A hard cap on the number of entries and on the serialized size. Truncation is
explicit and reported in the digest, never silent. (Article I of the portfolio SOP: no unbounded
output into a downstream consumer.)

**4. Tenant-scoped.** A digest reads only the requesting tenant's runs. No cross-tenant aggregate
exists, in keeping with Constitution Article I.1.

**5. Data-sufficiency threshold.** Below a named minimum of **completed** runs, the digest is an
explicit `insufficient-data` record — a count of what is missing — not a conclusion. The threshold
is a documented default constant (the shape is version-controlled; the value is a parameter, per
Article IV.4). It is not a secret.

**6. Injection is OFF.** The digest is read-only and surfaced for inspection (an endpoint or a
CLI). Wiring it into `GoalIntakeService`/`IssueIntakeService` sits behind a doctrine flag that
defaults **off**, and OFF must be provably a no-op: zero prompt change, assertable. Enabling
injection is a later sprint, gated on real data existing.

**7. What it is not.** The digest does not mutate code, generate tasks, bypass or replace a gate,
auto-merge, or self-deploy. It is a summary that a human or a future, separately-reviewed feature
may read.

## Consequences

- WP-6 (Sprint 29) implements the read-only digest and the default-OFF wiring, and flips this
  ADR's status to **Accepted** in the same change (Constitution Scope rule 2).
- The digest is only as honest as the records. WP-3 (durable failure classification) is a
  prerequisite for a useful digest, because a class must exist before it can be counted.
- Definition of done for WP-6: a determinism test (same ledger → same bytes), a size-bound test, a
  tenant-isolation test, an `insufficient-data` test, and a flag-off no-op test proving no prompt
  change.

## Alternatives rejected

**LLM-summarised lessons.** Rejected. Non-deterministic, unfalsifiable, and a fabricated claim
about what happened — the exact class of statement Article V forbids.

**Auto-generate tasks from failures.** Rejected. Violates Part Two (irreversible action without
human review) and V.1. Task generation stays a reviewed draft; the digest may inform a future
drafter, it may not replace review.

**Feed raw run records into prompts.** Rejected. Unbounded, and run records can carry target-repo
content; injecting them wholesale into a prompt would put arbitrary recorded text across a
boundary without a fence.

**Penalise or score from failures into a single number.** Rejected for now. A single score invites
fabricated precision; named counts and classes are auditable, and an auditable number is the only
honest kind (Article V.1).
