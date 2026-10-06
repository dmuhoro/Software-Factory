# Operations and the Road to an Operating System

This document is honest about what Software Factory is, what it is not, and what stands between
it and something you can run your day on. It is written against the code, not the ambition.

Every claim below cites the file that establishes it. Where something is not built, it says so.

---

## 1. What this is today

Software Factory is a **multi-tenant control plane for producing verified software**, with an
explicit, auditable decision at every step that could cost money or destroy trust.

It is genuinely built:

| Capability | Evidence |
|---|---|
| 97 API routes across runs, approvals, releases, niches, quality | `src/api/routes/` |
| Multi-tenant durable storage with a real read path | `src/services/telemetryStore.ts:1` |
| One explicit storage backend, no silent fallback | `ADR-009` |
| A model-backed agent runner with leases, retries and worktrees | `src/services/agentRunnerService.ts:19` |
| Release + rollback with a real health check | `src/services/releaseService.ts:18`, `:22` |
| Niche adapters carrying real compliance guardrails | `src/configurations/factory.config.ts:39` |
| Path-traversal guards on all file writes | `src/services/factoryJobService.ts:87` |
| 137 tests across 20 files, six defence layers | `test/` |

What is real, in one line: **the governance, tenancy, evidence and release machinery is real and
tested. The part that makes it a factory rather than a control plane is not.**

---

## 2. The single largest gap, and it is one line

The autonomous agent path asks a model for an implementation, stores the answer, and then
deliberately fails the job:

```ts
// src/services/agentExecutionService.ts:11
status: 'PROPOSAL',
...
AgentRunnerService.complete(tenantId, job.id, {
  passed: false,
  error: 'PROPOSAL_REQUIRES_TOOL_APPLIER',
});
```

`PROPOSAL_REQUIRES_TOOL_APPLIER` appears in exactly one place in `src/`. **Nothing applies a
proposal.** No code in `src/services/` writes a model's output to disk.

Meanwhile `factoryJobService.ts:87` *does* write files — guarded by `resolveFileWithin` — but
only from an explicit `input.files` payload supplied by a caller. The writing capability exists
and is safe. The connection from model output to that capability does not.

So the current shape is:

```
  model  ──►  proposal (stored, auditable, discarded)
  caller ──►  {files: [...]}  ──►  real write, traversal-guarded
```

**That gap is the whole difference between a workspace and an OS.** A workspace shows you a
proposal and waits. An OS acts on it and shows you what it did.

Everything else on this list is real engineering. This one is a missing capability, and it is
the one to build next.

### The design constraint that must not be lost

The tool applier must never be "take the model's text and write it." That is how you get a
production outage with a green pipeline. The minimum safe shape:

1. The model returns **structured edits** (path, operation, content, and a stated verification
   command) — not prose to be parsed.
2. Every path resolves through `resolveFileWithin` (`factoryJobService.ts:87`), the same guard
   the safe path already uses.
3. Edits land in **an isolated git worktree**, never the primary branch — the worktree machinery
   in `ParallelWorktreeService` already exists for exactly this.
4. The worktree's **own** `npm run verify:full` must pass before anything is proposed for merge.
5. Merge requires a human approval token, which the approvals API already models
   (`POST /approvals/:approvalId/decision`).
6. Every applied edit is recorded with its evidence — because the constitution says behaviour
   without evidence is not a control.

If a proposal fails step 4, it is recorded as a **failure with the verification output attached**,
which is how the system learns and how you see why. Fail closed, and fail loudly.

---

## 3. Gap by layer, honestly

| Layer | Today | Gap to daily-driver |
|---|---|---|
| **Agent execution** | The unattended loop applies: guarded file writes, verification commands, one commit per unit (`npm run factory:run`). The inbox/agent-run API still proposes only. | **A hardened executor** for untrusted code (container/microVM). Everything else is downstream of this. |
| **Storage** | Local + Appwrite, one backend, tested | `NC-2` multi-replica writes unresolved. Appwrite adapter needs a consistency ADR before it carries money. |
| **Appwrite live** | Probe works; key currently rejected (401) | **Blocked on one console action:** grant scopes to the key. Nothing in code. |
| **Auth** | Tenant IDs carried through services | No real identity provider. Anyone with a tenant ID has that tenant's access. **This blocks any external user.** |
| **Observability** | `/metrics` Prometheus series exist | No dashboards, no alerts, no on-call. You would not know it broke. |
| **Deployment** | GHCR workflow written, image never published | Never run end to end. Kubernetes manifest has no published image and no digest pin. |
| **Dependency supply chain** | Policy gate exists | `skills-lock.json` not committed. Installs are not reproducible yet. |
| **Testing** | 176 unit/integration, including 7 end-to-end loop scenarios that drive real git repositories and a stub model port, plus a live run against a real local model (qwen2.5-coder:3b) that produced two verified commits | No end-to-end coverage of the inbox/agent-run API, and no fault-injection of the loop against a hostile target repository. |
| **Niches** | 3 operational, rest refuse honestly | Adding niches is gated on ADRs, correctly. `CustomB2B` should stay refusing. |
| **Recovery** | Rollback with health check | No backup/restore drill, no disaster recovery runbook, no RPO/RTO target. |

### The honest one-line assessment

The **control plane is roughly 70% of the way to something you can trust.** The **actuation
layer now has one working path**: the unattended loop takes a task document to verified commits
on a clean repository, with gates, an attempt cap and a report. That path is deliberately narrow
— one unit at a time, a target the loop trusts enough to run its own commands in, and no
boundary around untrusted code yet. A factory that can build *that* way, and only that way, is
still short of unrestricted actuation, but it is no longer a project manager that never builds.

---

## 4. What SF becomes when this lands

Not a workspace. Concretely, four capabilities that follow from the applier existing:

1. **It becomes the thing that actually ships.** You describe an outcome; it opens a worktree,
   writes the code, runs the full verification chain, and brings you a diff with evidence
   attached. The 97 routes, the quality gates and the approvals stop being infrastructure around
   a manual step and become infrastructure around *an autonomous step*.

2. **It becomes a durable record of engineering.** Every run, every applied edit, every
   verification result, every approval. Right now the audit trail records *intent*. Afterwards it
   records *what happened* — which is what makes it valuable six months later.

3. **It becomes trustworthy enough to widen.** Niche adapters can follow, because the mechanism
   for proving an adapter is correct is the same verification chain. The current honest refusal
   for unimplemented niches stays correct until then.

4. **It becomes an OS rather than a workspace.** The distinction is not branding. A workspace
   holds your code and shows you results. An OS runs your processes, schedules them, isolates
   them, enforces resource and permission boundaries, and recovers them when they fail. The
   scheduler (the lease-based queue in `agentRunnerService.ts:19`), the isolation (worktrees), the
   policy (gates, approvals) and the recovery (rollback) **already exist**. The kernel syscall —
   applying a change — is what's missing.

---

## 5. Sequenced next work

Dependency-ordered, because the earlier items make the later ones cheap.

**Now — unblock (hours, not engineering)**
- Grant the Appwrite key its scopes in the console. Re-run `npm run verify:full`.

**Layer 1 — Actuation (the priority)**
- `src/services/toolApplierService.ts` — structured edits, `resolveFileWithin`, worktree-scoped.
- Run the target repo's own `verify:full` inside the worktree; record pass/fail with output.
- Route a passing proposal to the existing approvals API. Nothing merges without a human.
- Tests: traversal attempts rejected, non-zero verification blocks the merge, a passing edit
  lands and is provably readable back from disk.

**Layer 2 — Identity (blocks any external user)**
- Real authentication; tenant resolved from the credential, never from a caller-supplied string.

**Layer 3 — Durability**
- Backup/restore drill. Measure RPO/RTO rather than asserting them.
- Resolve `NC-2` for the local backend, or ratify Appwrite with its consistency ADR.

**Layer 4 — Operations**
- Publish and digest-pin the first image; run the manifest end to end.
- Dashboards and alerts on the metrics that already exist.

**Layer 5 — Reproducibility and assurance**
- Commit `skills-lock.json`.
- Independent security review. The gates are assertions; someone else has to try to break them.

**Layer 6 — Widening**
- Niche ADRs, one per niche, each with schema, adapter and acceptance tests. Only then does a
  niche stop refusing.

---

## 6. What is not claimed here

- That the agent builds working software yet. It does not.
- That the platform is safe for external users. There is no identity provider.
- That a production image has ever been built and run. None has.
- That three niches are implemented as compliance systems. They are adapters with guardrails
  declared and enforced in code paths; the compliance regimes named have not been independently
  certified by anyone.
- That any gate here has been independently audited. They are asserted by this repository.

`npm run verify:full` proves the code behaves as specified against the configured backends. That
is a real and useful claim. It is not a production-readiness claim, and the two should not be
confused.
