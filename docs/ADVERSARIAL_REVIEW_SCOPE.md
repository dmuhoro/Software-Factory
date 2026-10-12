# Adversarial Review — True Scope

Status: implemented in `src/services/reviewService.ts`, enforced by the `review-approve`
gate at `review.after`. This document states what that gate actually does and, just as
importantly, what it does not. It exists because a review that is trusted for more than it
can prove is worse than no review at all.

## What runs

Before a unit may be committed, the change is put to **two independent LLM reads** — the `standards`
axis and the `spec` axis — each given (`buildReviewPrompts`, `reviewService.ts:258`):

- the unit's acceptance criteria and the task document's goal;
- the verification evidence the loop actually recorded (`attemptDiff`, `reviewService.ts:119`);
- a repository architecture brief drawn from the repository's own inventory and manifests;
- the change's diff, **including untracked files** (a plain `git diff` would hide new files).

Each axis returns one JSON object: `{"approved": boolean, "findings": string[]}`. The change is
approved only when **both** approve (`ReviewService.review`, `reviewService.ts:322`); findings are the
union, each prefixed with the axis that raised it. A rejection with no findings is itself refused —
the next attempt must be told what to fix.

The two axes are deliberately disjoint. `standards` (`AXIS_FOCUS.standards`, `reviewService.ts:202`)
judges repository fit; `spec` judges criterion truth. Their rejection rules are, verbatim:

**standards** — does the change fit the repository as it is?
- it contradicts the repository's stated architecture without the task asking for that restructuring;
- the diff would break other callers, states, or platforms the inventory shows exist;
- it adds code no criterion requests, or touches files unrelated to the unit;
- it deepens a module's interface or duplicates existing logic instead of hiding behaviour;
- it is a stub, a mock, a hardcoded answer, or a placeholder;

**spec** — does the unit's acceptance criteria actually hold, by real behaviour?
- a criterion is met only by the test itself, or is not met at all;
- the change adds behaviour no criterion requests (unrequested scope);
- verification was gamed, skipped, or narrated instead of executed;
- it is a stub, a mock, or a hardcoded answer that cannot satisfy a criterion in production;

**both** — credentials, keys, or environment secrets appear in the diff.

## What it guarantees

- **A machine, not a narrator, holds the line.** The gates run real commands and record
  real exit codes; evidence is derived from execution. A unit's own narration is recorded
  as `narrationRejected` and discarded, never treated as proof.
- **Two disjoint reads, both blocking.** A change must satisfy both the standards axis and the
  spec axis; one axis approving never softens the other, and an axis that errors fails the whole
  review closed. This removes the single-read trade-off where repository fit and criterion truth
  compete for the same attention.
- **Refusal is explicit.** A failed or malformed review is a named, recorded refusal that
  costs the attempt — there is no silent approval.
- **It catches at least one class of change no automated gate can**: a change that satisfies
  every check while touching files or code the unit never claimed. Observed in the
  die-and-resume drill: the reviewer refused all three attempts of a unit whose diff
  contained an untracked `verify-ran` residue unrelated to its acceptance criteria.

## What it does **not** do

- **It is not a security audit.** Rule 6 above catches secrets that appear literally in the
  diff. It does not do taint analysis, authorization review, cryptography review, or
  dependency-risk analysis. A vulnerability that does not look like a secret passes.
- **It is not a correctness proof.** It reads text; it does not execute the change. A
  logically wrong change that satisfies its criteria is approved.
- **The two axes are not independent verification.** They are separate prompts to the same model
  configuration, so correlated blind spots survive: the axes remove the attention trade-off, not the
  correlation. The reviewer may be the same model family as the implementer.
- **It is probabilistic, not a decision procedure.** The same diff may be judged
  differently across runs. It is a heuristic gate, not a deterministic one.
- **It sees only what it is given.** The diff is truncated at `MAX_DIFF_CHARS = 60_000`
  (`reviewService.ts:45`); a change hidden beyond that cut is not reviewed. It cannot see
  behaviour that is not expressed in the diff or the architecture brief.
- **It does not replace the deterministic gates or the tests.** It runs *after* automated
  verification and is defense in depth, never the first or only line.

## How to verify these claims

- Honest vs gamed fixtures (the reviewer approves a real fix and refuses a gamed one):
  `test/loop-execution.test.ts`.
- Unrelated-file refusal and the full die-and-resume drill:
  run ids `looprun_875b855f07096ade7d02c68d` (interrupted) / resumed to one commit,
  alongside the reviewer refusals in the first drill run.