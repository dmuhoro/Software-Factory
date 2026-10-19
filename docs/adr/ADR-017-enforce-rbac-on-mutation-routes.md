# ADR-017: Enforce role-based access control on mutation routes

## Status

Accepted.

## Context

`RbacService` (sprint 25) models principals → roles → permissions → resources,
and `whoami` reports what a caller holds. But no route called `RbacService.check`,
so an `auditor` binding did not by itself refuse a `loop:cancel`, and a scoped
credential could reach any mutation route its tenant-scoped token reached. The
enforcement boundary existed in the service layer but not at the route boundary
where calls arrive.

## Decision

Mutation routes that change repository state or dispatch model work now require
RBAC before the tenant check's downstream work runs:

- `POST /api/tool-apply/apply` → `loop:submit` (applies model output to disk)
- `POST /api/tool-apply/approve` → `loop:submit` (merges a verified branch)
- `POST /api/tool-apply/reject` → `loop:submit` (rejects a pending apply)
- `GET /api/tool-apply/records` → `loop:read` (audit read of applies)
- `POST /api/operations/queue/execute-proposal` → `loop:submit` (dispatches a model
  request against a real worktree)
- `POST /api/operations/runs/:runId/merge-next` → `loop:submit` (merges a run's
  next worktree onto the target branch)
- `POST /api/loop/runs` → `loop:submit` (submits an unattended loop run)

A principal with no binding holds no role and no permission. A binding limited to
named resources is honoured; anything outside it is refused with
`RBAC_RESOURCE_OUT_OF_SCOPE`. Fail closed: an unrecognised permission or a missing
binding is a 403, never a pass.

`src/api/middleware/rbac.ts` exports `rbacRequire(permission, resourceFrom?)`,
returning `false` (and sending 401/403) on refusal so route handlers short-circuit.

## Consequences

- Positive: every state-changing or model-dispatching route now enforces RBAC at
  the boundary where the request arrives, not deep in the service layer. A scoped
  credential can no longer reach a mutation its role does not hold.
- Negative: operators must create `RbacService` bindings for non-admin principals
  before those principals can submit runs or apply edits; an admin binding with the
  wildcard resource is required for full access.
- Recovery: removing a binding immediately revokes the principal's ability to act;
  no cached token survives revocation because the check reads the live binding on
  every request.

## Related

- `src/services/rbacService.ts` — the service layer decision
- `src/api/middleware/tenantAuth.ts` — authentication that produces the principal
- Sprint 34, WP-8 (P0 Identity)
