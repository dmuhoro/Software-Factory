# Machine-Building Contract

## Purpose

This contract records the implementation layers completed before the final local reality-verification phase. It distinguishes durable machine capability from proof that the capability works under real operating conditions.

## Completed machine layers

### Durable worker execution

The factory now has durable queue jobs, worker leases, retry limits, lease expiry recovery, cancellation, completion records, and worktree status updates. A restarted worker can resume an expired lease without losing the task record.

The model bridge can claim a task, request a bounded implementation proposal from a configured provider, persist the response, and route the task into the explicit tool-applier boundary. It does not falsely claim that a model proposal changed files.

### Runtime policy boundary

Sandbox policies now specify runtime, source boundary, writable workspace, network mode, host allowlist, secret references, CPU budget, memory budget, disk budget, process limit, timeout, and runtime image. Policies reject unapproved source paths, invalid secret references, and allowlisted networking without an allowlist.

The policy contract is ready for a container or microVM executor. The current local execution adapter remains available for deterministic development verification; it is not represented as a kernel-level security boundary.

### Delivery operations

Deployment observation records now support observation windows, health checks, consecutive-failure thresholds, durable runtime-health failures, and rollback recommendations. Ordered merge operations can merge completed worktrees, record merge commits, detect conflicts, abort conflicted merges, and preserve conflict evidence.

### Quality gates

Project adapters now detect the supported repository family and return a declared verification contract. Deterministic security scanning detects credential-like material and can run package audit when a lockfile is present. High-severity findings produce a blocked scan record.

### Operations API

Authenticated operations endpoints expose queue enqueue/claim/complete/cancel, proposal execution, sandbox policy creation, observation checks, rollback, ordered merge, project adapter detection, and security scans.

## Remaining implementation boundaries

The following are intentionally not claimed as complete machine capability:

1. A production container or microVM process executor that enforces the sandbox policy at the kernel/runtime level.
2. Automatic file-edit tool application from model output with schema validation and command allowlists.
3. A provider-specific hosted deployment adapter with real secret injection and infrastructure rollback.
4. Automatic polling of a real deployment health endpoint.
5. A full operations dashboard for the new queue, agent, deployment, and proof APIs.
6. Transactional multi-process storage beyond the atomic local JSON ledger.
7. Automated lifecycle migration tooling for future ledger schema versions.

These are implementation extensions that can be added before the final reality-verification step if they are required for the intended local workflow. None should be replaced by a claim of readiness.

## Final verification target

After machine construction is complete, the final verification phase should exercise the finished system against real local repositories and toolchains. It should collect founder-run, client-like, deployment, failure-recovery, security, and multi-agent evidence into the readiness ledger. Only that final phase can establish whether the implemented machine is operationally ready for the user's actual workflow.
