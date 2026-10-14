# Sprint 28 — The Orchestration Layer

**Status:** engineering complete · **Opened:** 2026-10-12 · **Closed:** 2026-10-14
(WP-1…WP-4 shipped through 4.13.25; WP-5 parked on an operator input, not an engineering task)

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
| **WP-2** | Tracker bridge: issue → spec → tickets with blocking edges | an issue produces a task document whose DAG blocks correctly | **done (4.13.23)** |
| WP-3 | Concurrent execution driver over worktrees + task graph | two independent units run at once; a dependent unit waits | **done (4.13.24)** |
| WP-4 | PR flow adapter: local branch + manifest default, GitHub behind a credential | a completed run yields a reviewable branch/manifest, never a silent commit | **done (4.13.25)** |
| WP-5 | Model layer: the frontier provider actually answers | a hosted model key is required; blocked, not worked around | **blocked (operator key + egress permit; code complete)** |

WP-5 depends on an operator input that is not code — a hosted model provider key with spend
(and, for WP-4's real-PR half, a GitHub App/token). The blocker is named rather than worked
around; the code halves that do not need the credential are delivered.

For WP-5 the code half is *already complete*: a model provider registered against the guarded
egress path answers end to end (`FrontierModelService.request`), and the loop refuses to start a
unit whose assigned provider is not registered (`tenantProviders`). What is missing is not code —
it is an operator-registered provider whose secret reference is allowlisted
(`FACTORY_ALLOWED_SECRET_REFS`), whose host is permitted (`FACTORY_MODEL_ALLOWED_HOSTS`), and which
has spend. There is no honest way to fabricate that answer here, so WP-5 is parked rather than
stubbed (SOP §9).

## WP-2 — The tracker bridge (4.13.23)

**The gap:** a goal always had a way in (`GoalIntakeService`); a tracker issue had none. The bridge
reads an issue from one of two sources and drafts the task document through the *same* model
contract and the loop's own parser as goal intake, so an issue-drafted document is no more trusted
than a goal-drafted one.

**Fix:**
- `IssueTrackerService` (new): `local` reads a JSON object with a `title` or markdown with a `# `
  heading inside the approved workspace; `github` reads the REST API through the guarded egress
  path (`egressJson`) with the token from `resolveSecretRef` — refused before any socket when there
  is no allowlisted token. Statuses/shapes map explicitly (`ISSUE_GITHUB_NOT_FOUND`,
  `ISSUE_GITHUB_AUTH_FAILED`, `ISSUE_GITHUB_IS_PULL_REQUEST`, `ISSUE_GITHUB_FETCH_FAILED`,
  `ISSUE_GITHUB_RESPONSE_INVALID`).
- `IssueIntakeService` (new): the thin bridge — fetch, then `draftTaskDocument` (parsed and written
  by the loop's own parser exactly like a goal draft). `goalIntakeService.ts` exports the shared
  `draftTaskDocument`/`taskDocumentSystem`.
- `POST /api/loop/issues` (new): mirrors the goals route, returns `201` with the validated draft.

**Evidence:** `test/issue-intake.test.ts` (new, 12 arms): both local formats; empty/malformed/
no-title/prose refusals; outside-workspace refusal; no-token refusal before any dial;
repo/number shape guard; one issue read through the guarded egress path against a loopback stub;
404/401/403/503/non-issue/pull-request mapping; the bridge drafting a two-milestone document with
the `depends` edge preserved and the parser accepting it; parser-rejected draft refused
(`LOOP_ISSUE_DRAFT_INVALID`); the model never dialled when the issue cannot be read.
**Failing-first:** removing the JSON-title guard makes the refusal arm fail. Full suite:
**377/377**; `npm run verify` green (Layer 4 42/42); docs gate 6/6; secrets gate pass.

**Honest limit:** the GitHub *real-network* success path stays behind its allowlist — `api.github.com`
is not allowed here, which is the point: without the operator's allowlist the adapter fails closed.

## WP-3 — The concurrent execution driver (4.13.24)

**The gap:** the doctrine advertised a `worktree-parallel` execution mode with concurrency ceilings,
but the driver only ever ran the sequential for-loop — a mode the doctrine permitted was one the
driver refused. The sequential loop also serialized even errands with nothing between them, so a
plan of independent units took their sum of wall clock, not their max.

**Fix:**
- `ExecutionLoopService.run` branches on `concurrency.execution`. `worktree-parallel` schedules the
  unit DAG over real per-unit git worktrees (`workspaceRoot()/.factory-worktrees/<runId>/`,
  branches `factory/<runId12>/<milestone>-<unit>`), bounded by
  `max(1, ResourceGovernorService.cap(maxParallelDefault))`. Independent units run concurrently; a
  unit is launched only after every dependency has been **merged** onto the target branch — gating
  on the merged line, not merely on a proposed branch.
- Each worktree runs the full pipeline unchanged: implement → verify (sandboxed) → two-axis review
  → feature commit carrying Proof/Verified/AI-Assisted → `--no-ff` merge. The run record gains
  `merges` and per-unit `mergeSha`; the report gains a Merges section; `LoopEvent.stage` grows
  `merge`.
- A unit whose verification never passes burns its attempt cap, is reported **stuck**, and its
  worktree branch is kept for the operator — nothing merges, nothing half-ships, no silent drop.
- A merge git cannot resolve is never auto-resolved: `mergeUnitBranch` runs `git merge --abort` and
  the run hard-stops `merge-conflict:<unit>`, leaving the target branch at the last good merge.
- Worktree-parallel runs are refused on resume (`LOOP_RUN_INCOMPATIBLE`: "worktree-parallel runs
  cannot be resumed") — honest, since resuming mid-worktree is not implemented.
- Codes added: `LOOP_TARGET_NOT_BRANCH`, `WORKTREE_CREATION_FAILED` (contract-mapped in
  `apiError.ts`, registered in `l3-error-contract`).

**Evidence:** `test/parallel-execution.test.ts` (new, 4 arms, same real `ExecutionLoopService.run`
against real repositories): two independent units provably in flight at once — a barrier stub holds
the implementer responses until two are airborne (`maxConcurrentImplementer >= 2`) and the
dependent unit's first event is ordered after its dependency's merge event; a unit whose verify
always fails goes 3 attempts → stuck, zero commits, zero merges, branch kept, target branch
untouched; both units editing `README.md` differently → `merge-conflict` halt (exit 3), only the
winner's files reachable on the line; resume refusal. `test/loop-execution.test.ts` replaces the
obsolete `EXECUTION_MODE_UNSUPPORTED` arm with a worktree-parallel completion + merge-evidence arm.
**Failing-first:** the very first parallel run deadlocked — a finished job never removed itself from
the running pool, so the scheduler believed the pool was full forever; the barrier test timed the
suite out (no completion signal existed), the fix (`finally { running.delete(unit) }`) made the
proof pass on the next run. Full suite: **381/381**; `npm run verify` green (Layer 4 42/42); docs
gate 6/6; secrets gate pass.

**Honest limits:** the concurrency budget respects the machine, but bwrap sampling still runs in
`/approved` — in the shipped containers without bubblewrap, sandboxed verification fails closed
exactly as documented (ADR-010, DEPLOY_DOCKER/DEPLOY_RAILWAY). Worktree-parallel runs are
intentionally not resumable; the sequential path keeps its resume behavior.

## WP-4 — The pull request flow (4.13.25)

**The gap:** a run that finished left its work inline on whatever branch it happened to be on —
no reviewable artifact, no manifest of the commits and merges it had made, and no path to a pull
request. The "workforce" vision needs a change to reach a human as something reviewable, not as a
silent commit on a shared branch.

**Fix:**
- `prFlowService` (new) drafts three things, each derived from the run: a durable `pullRequests`
  record, a rendered manifest (title, per-commit proof digest, merge list, open-unit list), and a
  branch ref `factory/pr/<runId12>` at the run head. `mergeable` reports the run's own verdict: a
  `halted` run or any unit not `done` is not mergeable.
- The GitHub half fails closed **before the network**: `resolveSecretRef` first
  (`PR_GITHUB_TOKEN_REQUIRED` on empty/malformed/non-allowlisted), then owner/name, head, and a
  base-URL re-validation at the `egressJson` socket. It maps 401/403, 422, and other non-2xx
  explicitly, and never merges.
- A new optional `loop.json:pullRequest` block (absent ⇒ off) gates a post-report auto-draft; a
  draft failure is a `warn` event and never changes the run's exit code. `github` mode must name an
  allowlisted `github:tokenSecret`, validated at parse time.
- Endpoints `POST`/`GET /api/operations/runs/:runId/pr`; `pullRequests` collection and
  `LEDGER_VERSION` 8; the ten `PR_*` codes join `apiError.ts` and `l3-error-contract`.
- A real defect was found and fixed by the test: the record id was minted with a
  time/process-varying id, so `getRecord` could never resolve the record a `draft` had written; the
  id is now content-derived (`DurableStore.deterministicId`), so a re-draft overwrites in place.

**Evidence:** `test/pr-flow.test.ts` (new, 3 arms) drives the real service against real git
repositories — the local draft writes a record that `getRecord` resolves, a real branch ref at HEAD,
and a truthful manifest; a halted run is not mergeable; the GitHub path refuses with
`PR_GITHUB_TOKEN_REQUIRED` with no socket. Full suite: **384/384**; docs gate 6/6; secrets gate
pass. **Failing-first:** the `getRecord` mismatch above failed the local-draft arm before the id
was made deterministic.

**Honest limits:** the local half is fully proven here; the GitHub half proves only the refusal
before the socket and the loopback path — a live GitHub pull request needs an operator-appointed
allowlisted token and an egress permit, neither of which is in this environment.

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

- **WP-5 — hosted frontier answer (owner: operator):** the model layer's code is complete and
  proven against a real loopback provider; the hosted answer needs an operator-registered provider
  with (a) an allowlisted secret reference present in the process environment
  (`FACTORY_ALLOWED_SECRET_REFS`), (b) its host permitted (`FACTORY_MODEL_ALLOWED_HOSTS`), and (c)
  spend. Until then the frontier tier cannot answer and the loop fails closed — it never fabricates
  a response. Unblock condition: both env allowlists set and the referenced key present.
- **WP-4 — real GitHub pull request (owner: operator):** the local flow is done (4.13.25); opening
  on GitHub needs an operator-appointed allowlisted token and an egress permit. The refusal path
  (before any socket) is proven; the live open is not testable here.
- **WP-3 sandbox:** the shipped container runs no bubblewrap, so sandboxed execution in-container
  requires `--privileged` (documented in ADR-010) — an operator decision, not a code change.
