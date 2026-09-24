# Sprint 14: Machine-Building Completion Before Reality Verification

## Objective

Finish the high-leverage product machinery before connecting the factory to the founder's local terminal for final real-world verification.

## Completed layers

- Durable queue jobs with worker leases, expiry recovery, retries, cancellation, and completion evidence.
- Bounded model-to-queue execution bridge that persists proposals without pretending files changed.
- Explicit sandbox policy contract covering source boundaries, writable workspace, network, secret references, resource budgets, process limits, timeout, and runtime image.
- Durable post-deployment observation records with failure thresholds and rollback recommendations.
- Ordered worktree merge operations with conflict capture and merge evidence.
- Project-family adapter detection for Node, Python, Rust, Android, static, and unknown repositories.
- Deterministic credential-like secret scanning and package-audit integration when a lockfile exists.
- Authenticated operations APIs for queue, sandbox, observation, merge, adapter, and security controls.

## Verification evidence

The complete automated suite passes 26 tests and TypeScript lint passes. The production build remains part of the final verification command. The machine layer tests cover queue recovery, sandbox boundary policy, project detection, and security blocking in addition to the existing founder, delivery, harness, client, deployment, autonomy, and proof tests.

## Explicit boundaries

The local JSON ledger is still a single-process durable adapter. The policy service defines the hardened runtime contract but does not itself create a kernel-level container or microVM. The model bridge produces bounded proposals and routes file mutation to an explicit tool-applier boundary; it does not silently apply arbitrary model text. A provider-specific hosted deployment adapter and full operations dashboard remain possible extensions if the local workflow requires them.

## Next phase

The next phase is the final reality-verification program on the connected local machine. That phase should exercise the completed machine against real repositories, toolchains, deployment targets, failures, client-like handovers, and multi-agent worktrees, then populate the proof ledger and make the readiness determination.
