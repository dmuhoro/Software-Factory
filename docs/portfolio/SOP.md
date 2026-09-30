# Engineering Operating SOP

**Scope:** every repository in the portfolio. This is the *how* that sits above the
*what* in each repository's constitution. Where this SOP and a repository's constitution
both apply, the constitution governs the domain; this SOP governs the workflow. Neither
may be satisfied by a claim instead of a check.

**Authority:** this file is a companion to `docs/CONSTITUTION.md` (Part Two, adopted by
reference) and `docs/portfolio/README.md` (the drift rule). It does not restate domain
rules and does not override any repository's own constitution.

---

## Stage 0 — Before touching anything

**Never skip this stage because the change is small.** The cost of skipping it is highest
on small changes, because a small change is the one nobody reviews.

1. **Find the repository's constitution, ADRs, and contributor guide.** Read them before
   reading the code. A change that violates an ADR is not a refactor; it is a new
   architecture decision, and it needs a new ADR.
2. **Check for an existing non-conformance record.** If the change touches a recorded gap,
   the change is expected to close it, and closing it means removing the record entry in
   the same change.
3. **Locate the real boundary.** For anything touching tenants, money, credentials, or
   submission, grep for the actual call site in the live path and cite `file:line` before
   proposing an edit. A fix in a helper that only tests or offline paths use is not a fix.
4. **Confirm the environment can prove the change.** If it cannot — no credentials, no
   service, no cluster — decide *now* what the evidence will be, and record the limit in
   the sprint record rather than discovering it at the end.
5. **Write the plan, then challenge the plan.** Ask what would make this wrong: what is the
   insertion point, what does the gate actually cover, does the scope contradict its own
   constraints. If the plan is flawed, say so and propose the corrected version *before*
   editing. A flawed plan executed "because it is close" is the single most expensive
   outcome available in this workflow.

## Stage 1 — Sequencing

**Work in layers. Finish a layer before opening the next.** Layers overlap only when a
layer's own tests are the evidence for the layer above it, and that dependency is stated.

1. **Governance before code.** A principle is written and sourced before the implementation
   that claims to satisfy it.
2. **Core before edges.** Storage and identity before routing; routing before integrations.
3. **Each layer closes with its own evidence,** collected before the next layer starts.
   Evidence gathered at the end cannot attribute a pass to a specific change, and an
   unattributable pass is not evidence.
4. **Batches are not the unit of work. The commit is.** One concern per commit, in an order
   where each commit leaves the tree green. A commit that breaks the build and a later
   commit that fixes it is two commits that cannot be reviewed, cherry-picked, or reverted
   independently.

## Stage 2 — Implementation

1. **Production code, not scaffolding.** A stub that returns a plausible value is worse
   than an absent feature, because it is indistinguishable from a working one at the call
   site. If it must be a stub, it must be labelled and must fail loudly if reached in a
   non-dev path.
2. **Fail closed by default.** Defaults refuse. When the conservative choice is unclear,
   take the conservative one and record why.
3. **No silent degradation.** If a dependency is unavailable, the request is refused with a
   reason. A fallback that quietly changes the semantics of a result is a correctness bug.
4. **Types are a control, not a suggestion.** No unbounded `any`, no `as unknown as X`, no
   non-null assertion outside justified tests. A cast converts a compile error into a
   production failure.
5. **No floating point on money or quotas.** Integer minor units or arbitrary-precision
   decimal. This is arithmetic, not style: binary float cannot represent `0.10` exactly.
6. **Every rejection is loud.** Clear reason to the caller, audit record, metric. A rejection
   that leaves no trace will be re-attempted forever by whoever cannot see it.
7. **Secrets are not parameters.** Structure in version control; credentials and tuned
   constants out of it. Never print, echo, log, or commit a secret — not in a diagnostic,
   not in a test fixture, not in a commit message.
8. **New dependency requires recorded justification** in the commit body: what it replaces,
   its supply-chain and maintenance status, the alternative considered. The default answer
   is no.

## Stage 3 — Proof

**A test proves a path only if it exercises the real one.** This is the stage where most
false confidence is manufactured, so it is the stage with the strictest rules.

1. **The real path, or it is not a proof.** A test of a standalone module does not prove
   wiring. The assertion must be that the production function was invoked, or refused, on
   the real route.
2. **Every new test is shown to fail without its fix.** Revert the fix, observe the failure,
   restore the fix. A test that cannot fail is not evidence — it is decoration. **Record the
   negative result**, not just the green one.
3. **Never weaken or delete a test to make a build pass.** A green suite means the code is
   correct, not that the assertions were removed. This includes raising a threshold,
   loosening a matcher, adding a skip, or widening a type to admit the wrong value.
4. **A pass count never implies a defect is resolved.** A suite growing from 24 to 26 checks
   says two assertions were added. It says nothing about the other 18.
5. **Gates that a build can check outrank rules stated in prose.** Prefer a script that
   fails. Then, having written it, verify the script fails when the rule is violated —
   a gate that has never been observed failing is an unproven gate.
6. **Full sweep, not a subset.** Typecheck, lint, unit, integration, and the live harness
   for every layer touched. A green subset is a claim about the subset.
7. **Verify the fix at the boundary, and prove the old path is unreachable.** Not only that
   the new check rejects — that the check *is* on the real path, so nothing bypasses it.

## Stage 4 — Truthful documentation

1. **Documentation that contradicts the code is a defect, not a nit.** A stale document is
   worse than a missing one, because it is trusted.
2. **No claim of capability without a named command and its output.** "Implemented",
   "verified", "production-ready" each require a demonstrating check. Where verification was
   impossible, the document says so — it does not imply coverage.
3. **Update the record in the same change as the behaviour.** Changelog, sprint record,
   non-conformance list, and README move together with the code. A behaviour change with
   stale documentation is an incomplete change.
4. **Honest zero beats false representation.** No traction, no customers, no live
   integration, no build: say the number is zero or say the proof is absent. Never describe
   a prototype as a production system or a projection as a measurement.

## Stage 5 — Release

1. **Every shipped change gets a version and a tag.** Never ship untagged. Never let a
   hotfix drift behind the last tag while product behaviour changed.
2. **One product, one version.** npm, crate, and changelog agree. Enforced by
   `scripts/verify-release.sh`, not by diligence.
3. **Tag what was tested.** The tag points at the commit whose checks passed.
4. **Provenance.** Every commit with meaningful agent-generated content carries an
   `AI-Assisted:` footer naming the models used, and is human-reviewed before push.
5. **Verify the tag after pushing.** Confirm the remote ref exists and matches local. An
   unpushed tag is invisible to every collaborator and to CI.

## Stage 6 — Handover and honesty

1. **Report the residual risk accurately.** Closing one gap never means the area is
   complete. Name what is now safe and what is still open.
2. **Surface blocked work as blocked,** with the specific blocker and its owner. Work
   waiting on a credential is not an engineering backlog and must not be scheduled as one.
3. **Carry open decisions forward explicitly,** as decisions, with the options and the
   value at stake — not as silent omission.
4. **Leave the tree clean.** No uncommitted work, no stray processes, no leaked listeners,
   no placeholder files. Verify, do not assume.

---

## Anti-patterns this SOP exists to prevent

| Anti-pattern | Why it is expensive | What the SOP requires instead |
|---|---|---|
| Test passes, real path unguarded | False confidence outlives the task | Stage 3.1 — assert on the real route |
| Assertion weakened to go green | The defect ships wearing a green suite | Stage 3.3 — never weaken a test |
| Gate never observed failing | The gate is decorative | Stage 3.5 — break the rule, see it fail |
| Fix in the test-only helper | Real production stays open | Stage 0.3 — find the real boundary first |
| Number hardcoded to a target | A business claim nobody re-derives | Stage 2.1 — no plausible stubs |
| Docs shipped ahead of code | Stale docs get trusted | Stage 4.3 — docs move with behaviour |
| "Verified" without a command | Unfalsifiable claim | Stage 4.2 — name the check and its output |
| Untagged hotfix | No way to identify what shipped | Stage 5.1–5.3 |
| Scope creep mid-layer | Layer never closes, evidence never collected | Stage 1.1–1.3 |
| Flawed plan executed anyway | Most expensive available outcome | Stage 0.5 — say no early, loudly |

## Standing portfolio decisions (open)

Carried forward so they are not silently dropped between sprints.

- **Wave 4 (payments + generic `CustomB2B` adapters) — held.** It is the only wave whose
  value is not yet established. It also has the weakest case: the two paused projects are
  both blocked on owner-held credentials, not on missing adapter capability, and a payments
  adapter without a payments rail is a well-typed placeholder. Decide it explicitly, on the
  evidence, rather than by momentum.
- **Horizontal scalability (NC-2).** Requires a shared store and is a platform decision with
  a real cost, not a task to absorb quietly.
- **Canonical package manager (NC-3).** Two lockfiles until the CI-verified one is declared
  canonical and the other is removed.
- **Docker build verification (NC-4)** and **egress restriction (NC-5)**.
