# Levels 2–4 Implementation Contract

## Purpose

Levels 2–4 extend Software Factory from a founder-only workspace into a controlled client-delivery, production-release, and multi-agent manufacturing harness. These levels add capability; they do not automatically grant unrestricted authority. Authority is earned only after the proof ledger contains observed, reproducible evidence for every criterion.

## Level 2: Client delivery

The client-delivery layer creates a tenant-scoped client workspace with an isolated root, allowed-member list, retention policy, and data classification. It generates a reproducible handover pack containing product identity, verification evidence references, deployment and rollback runbooks, acceptance criteria, and known limitations. It records an explicit client acceptance decision and rejects acceptance criteria that lack evidence.

The layer supports personal and contract work without conflating client records. It does not include credentials or silently publish artifacts to a client.

### Level 2 exit criteria

| Criterion | Evidence required |
|---|---|
| Three client-like dry runs | Three independent job IDs with complete handover and acceptance records |
| Isolated client workspace | Workspace path, tenant scope, permissions, and cross-tenant negative test |
| Reproducible handover and acceptance | Handover checksum, acceptance record, and acceptance evidence references |

## Level 3: Production deployment

The hosted deployment layer introduces a provider-neutral target contract. The current adapters are `filesystem-hosted` for deterministic local verification and `webhook-hosted` for integration with a deployment service. A webhook target requires an endpoint and a secret reference; the secret value is resolved only from the runtime environment and is never stored in durable records.

Deployments are approval-gated, immutable, checksummed, observable, health-recorded, and rollback-aware. A failed observation is a durable failure signal and must not be treated as a successful release.

The current implementation proves the deployment contract with a local hosted adapter. A real hosted target is still required before claiming Level 3 production readiness.

### Level 3 exit criteria

| Criterion | Evidence required |
|---|---|
| Hosted deployment succeeds | Real target deployment ID, source commit, artifact checksum, and health observation |
| Secret isolation verified | Secret-reference record plus negative evidence showing no secret in logs, artifacts, or proof records |
| Health failure blocks or rolls back | Injected failed observation, durable failure, and verified previous-release recovery |

## Level 4: Governed autonomy

The frontier-model layer supports provider-neutral OpenAI-compatible endpoints, runtime model discovery, model selection, secret references, and bounded requests. It is deliberately not coupled to one vendor. A provider can be local, hosted, or a compatible frontier service.

The parallel-agent layer plans tasks, validates dependencies, creates one Git worktree per task, exposes only ready tasks, and calculates a deterministic merge order. Independent tasks can proceed in parallel; dependent tasks remain blocked until their prerequisites are complete. Each agent receives an explicit worktree and must not modify another worktree.

The current layer is an orchestration and governance contract. It does not pretend that a model request succeeded merely because a worktree was created. The local/cloud AI runner remains responsible for invoking the selected provider, applying changes, running verification, and reporting evidence through the API.

### Level 4 exit criteria

| Criterion | Evidence required |
|---|---|
| Hardened execution boundary | Container or microVM policy, escape tests, resource limits, secret isolation, and cleanup evidence |
| Parallel agents preserve task order | Multiple independent tasks, dependency-gated task, ordered merge plan, and conflict/recovery evidence |
| Irreversible actions escalate | Attempted deployment or external action blocked without approval and recorded in the audit ledger |

## Proof ledger

The proof API stores criteria, status, run IDs, artifact references, measurements, reviewer, and an evidence digest. A record cannot be marked `PASSED` without an observed timestamp, a run ID, and at least one artifact reference. A readiness level is not declaration-ready until every criterion is passed and none is failed.

This separates **capability completion** from **operational proof**. The system may build the machinery first, but it must not claim autonomy until real work has exercised the machinery under representative success and failure conditions.

## Authority progression

```text
Capability implemented
  → deterministic test passes
  → controlled dry run passes
  → real founder run passes
  → client-like run passes
  → production failure injection passes
  → proof ledger complete
  → autonomy scope expands by approved action class
```

Unrestricted authority is not a safe initial state. The intended endpoint is progressively earned autonomy with enforceable boundaries, not a blanket bypass of approval, tenant isolation, security, or recovery controls.
