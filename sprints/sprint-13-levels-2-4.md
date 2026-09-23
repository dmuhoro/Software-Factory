# Sprint 13: Levels 2–4 Manufacturing Harness

## Objective

Extend the founder workspace into a controlled product-manufacturing harness for client delivery, hosted release, frontier-model integration, parallel agent execution, and evidence-based readiness declarations.

## Completed layers

### Level 2: Client delivery

Added tenant-scoped client workspaces with isolated roots, retention policies, member allowlists, data classification, reproducible handover packs, checksums, explicit acceptance criteria, and acceptance evidence. This gives personal, product, and contract work a consistent handover boundary without putting client credentials into durable records.

### Level 3: Hosted deployment contract

Added provider-neutral hosted targets, secret-reference configuration, immutable artifact copies, checksums, approval-gated deployment, health observations, and rollback to the previous known-good deployment. The filesystem-hosted adapter is a deterministic proof adapter; a real hosted target remains an operational proof requirement.

### Level 4: Frontier models and parallel agents

Added a provider-neutral OpenAI-compatible model registry with runtime model discovery and secret references. Added dependency-aware agent runs with one Git worktree per task, ready-task scheduling, explicit worktree prompts, bounded parallelism, and deterministic merge ordering. This is orchestration governance; it does not claim that model execution or merging succeeded without recorded evidence.

### Proof ledger

Added readiness criteria, observed proof records, artifact references, measurements, reviewer identity, evidence digests, and readiness summaries. A passed record requires a run ID, observation timestamp, and artifact reference. A level is not declaration-ready until every criterion is passed and no criterion is failed.

## Verification evidence

The deterministic suite passes 23 tests, including client handover and acceptance, hosted deployment observation and rollback, frontier-provider registration, dependency-gated worktrees, and proof-ledger requirements. TypeScript lint and production build remain mandatory release checks.

## Honest readiness position

These layers close major capability gaps, but they do not by themselves prove unrestricted autonomous production operation. The remaining proof work is real-world execution: five complete founder jobs, three client-like dry runs, a real hosted deployment target, failure injection and rollback, secret-isolation checks, hardened untrusted-code execution, and a parallel-agent run with merge/conflict recovery evidence.

The correct progression is capability, deterministic test, controlled dry run, real founder run, client-like run, production failure injection, complete proof ledger, and only then a narrow expansion of autonomy scope.
