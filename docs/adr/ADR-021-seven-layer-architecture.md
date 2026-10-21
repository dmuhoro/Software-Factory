# ADR-021 — Seven-layer architecture for Software Factory

## Status

Accepted

## Context

Software Factory's README already describes four boundaries (Control, Agency, Runtime, Adapter). The product is expanding into new surfaces — a preview plane (visual rendering per commit), an AI bug detective (advisory diagnostics), observability (dashboards, alerts, on-call), and dual-language reporting (technical + founder/CEO). Four boundaries cannot cleanly hold these concerns without coupling governance to rendering, or diagnostics to the execution loop. A seven-layer model separates concerns so each layer can evolve, be tested, and be gated independently.

## Decision

Software Factory is organized into seven layers, each with a single responsibility and a strict boundary:

| Layer | Responsibility | Boundary rule |
|-------|---------------|---------------|
| L1 Control | Constitution, ADRs, doctrine, approval policies, capability manifest | No runtime writes; doctrine loads from outside the target repo |
| L2 Agency | Unattended loop (PLAN→IMPLEMENT→VERIFY→COMMIT→REPORT), branches, previews | The loop is the only writer of a target tree |
| L3 Runtime | Tenant-scoped jobs, durable ledger, outcomes, audit, recovery | Single writer; tenant-scoped; fail-closed readiness |
| L4 Adapter | Verification profiles, execution sandbox, deployment, model providers | Provider-specific behavior behind explicit ports |
| L5 Diagnostic | AI bug detective: error flagging, root-cause, remediation advice | Advisory only; never writes to a target tree; fail-closed |
| L6 Observability | Dashboards, alerts, on-call, metrics, health, cycle-time/defect/repair | Read-only views of durable records |
| L7 Interface | Frontend tabs, dual-language reporting, tool-agnostic IDE/CLI boundary | Every output has a technical and a founder/CEO rendering |

Key invariants carried across all layers:

- **Fail closed.** A check that cannot run refuses; it never degrades to "allowed".
- **No fabricated claims.** Every capability names the command or route that proves it (capability manifest).
- **No second writer.** Only the loop writes to a target tree; the diagnostic layer never writes.
- **Advisory diagnostics.** The bug detective emits diagnoses, never edits; any fix still runs VERIFY→REVIEW→COMMIT through L2 gates.
- **Dual vocabulary.** Every durable record renders in both technical and founder/CEO language; no figure appears without a named reproducing command.
- **Tool-agnostic.** The doctrine + gates + evidence boundary lives outside Cursor/Cline/any IDE; editors are clients of the boundary, not authors of it.

## Consequences

- New capabilities are registered in `src/services/capabilityManifest.ts` with a `proves` command/route (live) or an owner (blocked).
- L5 adds `src/services/bugDetectiveService.ts`, a `bug-diagnosis-evidence` gate, and a `defect` failure class — all advisory, fail-closed, measured.
- L2 gains the preview plane (ephemeral worktree + dev server + iframe/screenshot proxy, commit→preview mapping) as an additive tab; it does not alter the loop, doctrine, or any gate.
- L7 wires dual-language rendering into every API/CLI/frontend output; founders and engineers read the same record in different vocabularies.
- `README.md` and `AGENTS.md` are updated in the same change as any behavior-altering code.

## Related

- ADR-010 (isolated execution boundary)
- ADR-011 (one model-egress door)
- ADR-017 (RBAC on mutation routes)
- README Architecture section (four boundaries → seven layers)
