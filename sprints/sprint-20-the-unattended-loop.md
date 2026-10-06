# Sprint 20: the loop that runs to verified commits

- **Status**: Complete
- **Date**: 2026-10-06
- **Precedes**: `sprint-19-the-gates-that-were-not-running.md`
- **Branch**: `review/appwrite-pilot-4.8.0`

## The problem this sprint inherited

Sprint 19 ended with the honest sentence: **"The agent still does not act."**
`agentExecutionService.ts:11` failed every job with `PROPOSAL_REQUIRES_TOOL_APPLIER`, nothing
applied a model proposal to disk, and `docs/OPERATIONS.md` estimated the actuation layer at 0%.
The two hard constraints that had to survive the build, from that same document:

1. **The tool applier must never be "take the model's text and write it."** A model's own
   narration is evidence of nothing. An applied change is complete only when something other
   than the model says so.
2. **The rules of the loop must be enforced, not described.** Prose in an AGENTS.md is a
   suggestion the next prompt can outvote.

On top of those, the autopilot constraints from the planning session: model-agnostic
(provider/model per role, no hardcoded names at call sites), no mid-run check-ins, an attempt
cap with a STUCK record instead of an infinite retry, small commits each stating what was
verified, a doctrine that lives *outside* the target repository so the target cannot supply its
own rules, and one observable CLI with a documented exit-code contract.

## The design in one paragraph

A run is a sequence of stages over a set of *work units* parsed from one task document. Each
stage is entered with `plan-is-executable -> criticize-plan -> isolation-integrity ->
doctrine-integrity -> resource-admission -> doctrine-isolation -> secret-scan -> history-check ->
persist-forecast -> model-assignment -> plan-is-executable -> evidence-is-machine-derived ->
persist-forecast -> commit-declaration -> secret-scan -> history-check`. For each unit the loop
asks an implementer model for files, writes only what the model returned and the reviewer
accepted, runs the unit's verification command, and commits only when that command exited 0 —
then records the commands and their exit codes in the commit body and a `Proof:` digest.
Three attempts per unit, each quoting the previous refusal back to the model after rolling the
tree back to its pre-attempt snapshot. Then STUCK, recorded, and the next independent unit runs.
All thirteen gates are a single registry, every hook a doctrine rule names resolves, and every
rule's enforcement gate is declared by some stage — both directions are tested.

## What landed, layer by layer

**The doctrine became data (`11f8168`).** `doctrine/loop.json` (stage order, the attempt cap of
three, hard-stop budgets), `doctrine/agents/models.json` (provider/model per role, tier
fallbacks), `doctrine/rules/rules.json` (R-01 through R-12, each naming the gate that enforces
it), `doctrine/hooks/hooks.json` (gate ids and the stages that run them) and
`doctrine/manifest.json` pinning every file's sha256. `src/services/doctrineService.ts` parses
each file strictly — a comma meant as a separator is a parse error, not a tolerated convenience
— and `manifest.json` is verified before the loop starts: a doctrine that drifted from its
pins is refused, not re-pinned. Model assignments are resolved by
`FACTORY_MODEL_<ROLE>` -> `FACTORY_MODEL_TIER_<TIER>` -> task document -> doctrine, so a call
site never hardcodes a provider name.

**The task document and the ground truth (`9ad4c4c`).** `docs/TASK_DOCUMENT_FORMAT.md` and
`src/services/taskDocumentService.ts` parse the input: one `# Task:` heading, `Goal`,
`Constraints`, `Models`, `Verification` and `Milestones`; `### <id>: <title>` per milestone with
`type`, `independent`, `depends`, `split` and `verify`; acceptance criteria as `- [ ]` checkboxes
each with an optional nested `check:`. Unknown sections, a second top-level heading, unknown
dependency ids, cycles and more than five criteria per milestone are all refused with the line
that produced them. `src/services/groundTruthService.ts` signs evidence: the digest of the
verification report is recorded with the command list and exit codes, executed and committed
only when every exit code is 0.

**The target was quarantined and the resources admitted (`02d7fb3`).**
`doctrineIsolationService.ts` walks the target's `AGENTS.md`, `.claude/`, `opencode.json` and
friends, hashes them, and pins that quarantine manifest in the run — nothing is ever read, and a
change to the target's instructions is a manifest mismatch, not an applied suggestion. Every
subprocess the loop spawns gets `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
`resourceGovernorService.ts` grants tokens only along the attempt/report path, so a runaway loop
runs out of budget instead of running forever.

**The implementer and the commit (`f8a8027`).** `implementerService.ts` turns a unit into a
model prompt, then writes only the files the model returned (after the reviewer accepted them),
inside the workspace boundary. `commitService.ts` builds the conventional-commit message with a
narrative body — why, then what was verified, with the proof digest — and stages files only
after scanning staged content for credentials and staged paths against the doctrine's refuse
list; the scanner has to return nothing before a commit is allowed.

**The gates and the driver.** `src/services/loopTypes.ts` (run/unit/attempt/event shapes),
`src/services/gateIds.ts` (thirteen ids), and `src/services/loopGates.ts` (the registry:
`assertRegistryComplete` throws `GATE_NOT_IMPLEMENTED` if a hook names an unregistered gate,
`assertStageGates` throws `GATE_REFUSED` if a stage runs a gate that is not registered).
`executionLoopService.ts` is the driver: refuses a dirty tree (`REPO_NOT_CLEAN`), refuses a
worktree-parallel doctrine (`EXECUTION_MODE_UNSUPPORTED`), stages the worktree, decomposes the
document, then walks the topological unit order with gates, attempt loop, rollback, hard-stops
and the report stage, writing `<runId>.md` and `<runId>.json` on every outcome. A resumed run
re-derives the same IDs by hash, refuses an incompatible checkpoint, and never re-commits a
completed unit.

**The CLI and the end-to-end proof.** `scripts/run-factory-loop.ts`
(`--repo --task --tenant --attempt-cap --resume --report-dir --json`) exits 0 (all units
committed), 1 (refused to start), 2 (some units STUCK/BLOCKED) or 3 (hard stop).
`scripts/verify-loop.sh` runs the doctrine manifest check, the gate-wiring test, the seven
end-to-end scenarios, and the CLI contract. The scenarios drive **real git repositories against
a stub model port** (loopback HTTP, allowed by the local egress profile): the happy path commits
two verified units under `feat(m2):` / `feat(m1):` with all thirteen gates executed and zero
refusals; the attempt cap makes a unit STUCK while an independent unit still commits (exit 2); a
credential in the plan is refused with no commit; a dirty tree refuses the run; doctoring the
doctrine copy is a manifest mismatch the loop refuses without re-pinning; a worktree-parallel
doctrine refuses the start; a resume of a completed run is refused and a resume of a halted
checkpoint does not re-commit. The 31 unit-plus-integration tests from `e426517` observe gates
rejecting rather than describing, and the five commits before this sprint's final state each
left the tree green.

## Evidence

- `npm run verify` — 175 tests, 0 failures; TypeScript clean; production build clean;
  LAYER 4: 42 passed. Log: `/tmp/opencode/verify1.log` (exit=0).
- `npm run verify:loop` — 7 passed, 0 failed (doctrine manifest check, gate wiring,
  seven end-to-end scenarios, CLI exit-code contract).
- `npm run verify:docs` — every documented `npm run X` in the three live docs exists.
- `scripts/verify-release.sh` — all version records agree on 4.9.0 (`package.json`,
  `package-lock.json`, `software_factory/Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`).

## What this sprint did not fix

**The loop has never talked to a real model.** Every end-to-end scenario uses the stub model
port. The egress profile already permits loopback HTTP, so `models.implementer:
local/<serve-port>/v1` is the first real-model experiment — and the qwen2.5-coder path is the
pilot, not a shim.

**The loop writes files in the target repository; there is no container or microVM boundary.**
That is still the next hardened-executor gate on the README roadmap, and it is why the loop is
safe for trusted targets only.

**The inbox/agent-run API still proposes.** `agentExecutionService` behaviour is unchanged;
application is now a separate, task-document path. Nothing connects the two yet.

**Reports and resumes need a human look.** The run report is a first artifact, not a
board-ready one; the checkpoint store and `--resume` semantics deserve their own hardening
sprint before a long unattended run is trusted with real repositories on this branch.

**Appwrite and the image remain as sprint 19 left them.** The key is still rejected in the
console (`databases.read`, `rows.read`, `rows.write` on project `6aaa99700007bd53480e`);
no release tag has ever been cut, so no image has ever been published. Sprint 20 cuts
`v4.9.0` and back-fills `v4.8.0`; a container for *this* release is the first publish.