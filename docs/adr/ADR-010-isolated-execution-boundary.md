# ADR-010: The execution boundary is bwrap, and escape is asserted

- **Status**: Accepted
- **Date**: 2026-10-10
- **Resolves**: the missing governance record for the isolated execution boundary
- **Supersedes**: nothing

## Context

The factory runs commands on repositories it did not author. That is the whole point of the
product, and it is the whole risk: a verification command is arbitrary code. The repository has
carried an isolation mechanism and escape tests for several sprints, but no ADR named the
boundary, its scope, or its holes. A control without a record is a control the next reader
assumes does not exist — or worse, assumes covers more than it does.

There are in fact **three** separate mechanisms, built at different times, with different
strengths. Reading the code alone, it is easy to mistake one for another.

1. **The loop's sandbox** — `groundTruthService.runCommand` builds a `bubblewrap` (bwrap)
   invocation (`src/services/groundTruthService.ts:152-195`) with `--unshare-net` (when network
   is disabled), `--unshare-pid`, tmpfs mounts over `/tmp`, `/run`, `/home`, `/root`, a fresh
   `/proc`, and a read-only `--ro-bind / /`. It is used by the loop's verify stage
   (`src/services/executionLoopService.ts:550-559`) and the `no-op-unit` gate
   (`src/services/loopGates.ts:156`). This is the strongest boundary and the one R-14 is about.
2. **`ExecutionBoundaryService`** — an API-exposed service (`src/api/routes/workspace.routes.ts:24-25`)
   that copies a source tree to a throwaway snapshot and runs the detected verification profile
   there with a minimal environment. It confines the *source path* and sanitizes the environment,
   but runs no bwrap and does not unshare the network. `network: 'disabled'` is a manifest label,
   not an enforced state.
3. **`SandboxPolicyService`** — a policy *registry*. `createPolicy` validates and stores a policy;
   `planRun` creates a run with status `'PLANNED'` and executes nothing
   (`src/services/sandboxPolicyService.ts:16`). It is declarative, not an executor.

Three escape suites already exist and already refuse: `test/loop-sandbox.test.ts` (write to
`/etc`, network, host `/tmp`, `/proc` host process table, symlink escape, `writableDirs: ['..']`,
missing bwrap binary, unknown backend), `test/loop-task-document.test.ts:262-271` (implementer
path traversal into `../`, absolute paths, `.git`), and `test/machine-layers.test.ts:18`
(sandbox policy rejects `/home`).

## Decision

**1. The loop's verification commands run inside bwrap, and may never run bare.**

R-14 already says this (`doctrine/DOCTRINE.md`). The code did not fully enforce it: `runCommand`
falls through to a bare `sh -c` (`src/services/groundTruthService.ts:135`) whenever
`sandbox.enabled` is falsy, and `parseLoopConfig` accepted `enabled: false`. That is a rule the
code could be configured to break. `parseLoopConfig` now **refuses** a doctrine that disables the
sandbox (`src/services/doctrineService.ts`), so the only doctrine the loop will load has the
sandbox on. A command that cannot be sandboxed is refused, never run bare.

**2. Path containment is decided by `pathGuard`, on real paths.**

`ExecutionBoundaryService.createManifest` and `SandboxPolicyService.createPolicy` re-implemented
containment as a `path.resolve` prefix comparison. A prefix check on the unresolved string is
defeated by a symlink inside the workspace that points outside it — the exact defect
`src/utils/pathGuard.ts` was written to prevent, whose own header calls a duplicated check "a
chance to forget symlink resolution". Both now route through `pathGuard.resolveWithin`.

**3. The three mechanisms are documented for what each actually provides.**

This ADR is the record. A reader must not conclude that `ExecutionBoundaryService` provides bwrap
isolation, or that `SandboxPolicyService` executes anything; it does not, and it does not.

## Consequences

The escape proof is `npm test` — in particular `test/loop-sandbox.test.ts` (bwrap escapes) and
`test/wp7-execution-boundary.test.ts` (the doctrine cannot be disabled; the two boundary services
refuse traversal and symlink escapes; `pathGuard` refuses absolute, traversal, and symlink
escapes). Every arm is a negative control: reverting the fix makes the arm fail.

**Named, open gaps — recorded here rather than papered over:**

- **`verificationProfileService.executeVerification` runs unsandboxed.** It calls `execFileSync`
  directly (`src/services/verificationProfileService.ts:31`) and is reachable from the live route
  `POST /api/factory-jobs/:id/verify` via `factoryJobService.verifyRepository`
  (`src/services/factoryJobService.ts:93`). This path does **not** go through bwrap. It runs the
  target repository's own declared scripts, not caller-supplied argv, so the exposure is bounded —
  but it is a real execution path outside the boundary and is not covered by R-14 today. Closing
  it means routing `executeVerification` through `runCommand` with the doctrine sandbox, or
  refusing when the sandbox cannot start. **This is the highest-priority follow-up.**
- **`ExecutionBoundaryService` does not unshare the network.** Its `network: 'disabled'` is a
  label. Until its steps run through `sandboxArgv`, treat it as a snapshot/environment boundary,
  not a network boundary.
- **Rate-limit and RBAC boundaries are out of scope for this ADR** (see sprint-27, WP-4).

## Alternatives rejected

**Rely on the existing prose (R-14) without a gate.** Rejected: prose is a comment, and — per
ADR-008 — a control that is not asserted is a comment. The `enabled: false` hole existed in the
code alongside the prose that forbade it.

**Make `runCommand` hard-refuse whenever no sandbox is passed.** Rejected for now: `runCommand`
is also the ground-truth primitive used by call sites and tests that deliberately exercise the
non-sandboxed proof logic (`test/loop-ground-truth.test.ts`). The real execution path — the loop —
always supplies an enabled sandbox, and that is now guaranteed by refusing a doctrine that
disables it. Forcing every `runCommand` caller to opt in is a larger change tracked separately.

**Treat `ExecutionBoundaryService` and the bwrap sandbox as one boundary.** Rejected: they are
not. Merging them in the record would claim an isolation the former does not provide, which is
the failure mode this ADR exists to prevent.
