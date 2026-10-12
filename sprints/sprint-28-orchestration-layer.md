# Sprint 28 — The Orchestration Layer

**Status:** in progress · **Opened:** 2026-10-12

**Thesis:** the unattended loop is real and gated — it plans, implements, verifies,
reviews and commits a unit, and refuses when any gate fails. What the "workforce"
vision needs next is the layer *around* that loop: how work arrives, how several units
run at once, how a change reaches a human as a reviewable branch/PR, and which model
actually answers. This sprint builds that orchestration layer in sequence, one provable
concern per release, with a named proof command for every claim.

Follows `docs/CONSTITUTION.md`, the ADRs in `docs/adr/`, and the cross-repo SOP.

---

## The finding that scoped this sprint

An audit of the tree found **two disjoint orchestration stacks**, not one:

- **The sequential loop** (`goalIntakeService` → `taskDocumentService` → `ExecutionLoopService`,
  surfaces at `POST /api/loop/*`) — real, gated, and driving. `executionLoopService.ts`
  explicitly **refuses a non-sequential plan**, so concurrency cannot enter through it today.
- **The parallel scaffold** (`ParallelWorktreeService`, `AgentRunnerService`,
  `AgentExecutionService`, `MergeService`, surfaces at `/api/agents` + `/api/operations`) —
  a real worktree/task-graph engine whose model step only *proposes* a tool call and then
  always fails closed (`PROPOSAL_REQUIRES_TOOL_APPLIER`). Its merge is a local `git merge`,
  **not** a pull request.

Grep confirms **no GitHub integration anywhere** (no octokit, no `/pulls`, no `git push`).
So the gap is narrower and more honest than the framing: the pieces exist, they are just not
joined, and two of them (concurrency, PR flow) do not run end to end.

## Work packages

| WP | Objective | Proof | Status |
|---|---|---|---|
| **WP-1** | Two-axis review: standards and spec as independent, both-blocking reads | one axis refusing refuses the review; both dialled | **done (4.13.22)** |
| WP-2 | Tracker bridge: issue → spec → tickets with blocking edges | an issue produces a task document whose DAG blocks correctly | planned |
| WP-3 | Concurrent execution driver over worktrees + task graph | two independent units run at once; a dependent unit waits | planned |
| WP-4 | PR flow adapter: local branch + manifest default, GitHub behind a credential | a completed run yields a reviewable branch/manifest, never a silent commit | planned |
| WP-5 | Model layer: the frontier provider actually answers | a hosted model key is required; blocked, not worked around | blocked |

WP-5 depends on an operator input that is not code — a hosted model provider key with spend
(and, for WP-4's real-PR half, a GitHub App/token). The blocker is named rather than worked
around; the code halves that do not need the credential are delivered.

## WP-1 — Two-axis review (4.13.22)

**The defect:** `ReviewService.review` asked a single model read to judge a change on two
unrelated questions at once — *does it fit the repository?* and *does it do what the unit
asked?* — and approve on one boolean. Both sets of rejection grounds were listed in the prompt,
but one read weighs them against each other, so a change that fits beautifully and misses a
criterion (or vice versa) could still come back `approved`.

**Fix:**
- `ReviewService.review` now runs the two axes as **independent model reads** — `standards` and
  `spec` — each with its own system prompt (`AXIS_FOCUS`, `buildReviewPrompts(request, axis)`),
  and approves only when **both** approve. `ReviewResult` gains `axes`; `approved` is the
  conjunction; findings are the union, each prefixed with its axis (`[standards] …`).
- The axes are disjoint by construction: `standards` owns repository fit; `spec` owns criterion
  truth. Each prompt is told the other axis is a separate read that does not soften its verdict.
- A malformed or refusing axis **fails the review closed** (`Promise.all` rejects), so a change is
  never approved because the axis that would have refused stayed silent. `AttemptRecord.review`
  records the per-axis verdicts for the report.

**Evidence:** `test/review-two-axis.test.ts` (new, 4 arms) — the two prompts ask different
questions and each names its axis; standards-pass/spec-fail is refused with a `[spec]` finding;
standards-fail is refused even when spec approves; both-approve is approved with no findings, and
each axis is dialled exactly once. **Failing-first:** `axes.every(...)` → `axes[0].approved` makes
the spec-refusal arm fail. Full suite: **365/365**; `npm run verify` green (Layer 4 42/42).
`docs/ADVERSARIAL_REVIEW_SCOPE.md` updated to state both axes and their honest limits.

## Named blockers (not worked around)

- **WP-5 / WP-4-real-PR:** a hosted model key and a GitHub App/token are required; absent here,
  so those halves stay behind their input.
- **WP-3 sandbox:** the shipped container runs no bubblewrap, so sandboxed execution in-container
  requires `--privileged` (documented in ADR-010) — an operator decision, not a code change.
