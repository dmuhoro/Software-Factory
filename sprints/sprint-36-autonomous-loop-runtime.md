# Sprint 36 — Autonomous Loop Runtime Handoff

**Status:** closed · **Opened:** 2026-11-18 · **Closed:** 2026-11-18

**Thesis.** The autonomous loop must prove the real operator path, not only the in-process service path. A child CLI must start, acquire the durable ledger after an explicit parent handoff, emit its event stream, execute verification inside bwrap, and survive interruption/resume without duplicate commits.

## Root cause

The loop test harness and CLI spawn boundary were correct, but direct milestone verification commands such as `verify: node check.cjs` ran inside bwrap with `/home` masked. This sandbox uses a version-manager Node located under `/home/ubuntu/.nvm`, so `node` was invisible and the run stopped at the no-op gate with `SANDBOX_TOOLCHAIN_HIDDEN`. The missing event marker was initially misleading because the minimal probe also demonstrated that a parent process holding the durable ledger lock causes the child to exit before `onStart()`.

## Change

`src/services/groundTruthService.ts` now binds only the active runtime's bin directory after the masked-root mounts and constructs a minimal visible PATH containing that runtime, system bin directories, and the repository-local `node_modules/.bin`. `src/services/verificationProfileService.ts` resolves the same runtime even though its host path is under the masked `/home`, because the shared sandbox establishes the narrow bind. The `/home` mask remains intact; only the interpreter directory is exposed. This fixes direct task verification and repository-profile verification while preserving fail-closed sandbox behavior and credential/environment scrubbing.

## Evidence

- Direct CLI bootstrap: `node --import tsx scripts/run-factory-loop.ts --help` exits 0.
- Exact detached spawn probe: child emits `watch <events.jsonl>`.
- End-to-end CLI probe: reaches plan, implement, verify, and report stages after the parent releases the writer lock.
- `test/loop-die-resume.test.ts`: **4 pass, 0 fail** — model interruption, verification interruption, pre-commit interruption, and heartbeat-before-checkpoint reconciliation.
- Bubblewrap probes: runtime bind succeeds and the active Node version resolves inside the masked sandbox.

## Readiness boundary

The loop runtime is materially closer to daily founder use: the real child process path and interruption recovery are proven. Full-suite verification remains required after this focused fix. Hosted credentials, production deployment evidence, and a sustained real-repository trial remain separate readiness gates; this sprint does not claim unrestricted autonomy.
