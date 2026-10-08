# Sprint 25 — Borrowed Leverage

**Status:** open · **Opened:** 2026-10-08

**Thesis:** do not copy WorkOS features; copy its *shapes*. WorkOS has solved, in
production, five problems Software Factory is about to hit. Each phase below is
independently committable, has a failing-first test, and closes green.

Follows `docs/CONSTITUTION.md`, ADR-006, and the cross-repo SOP.

---

## Phase 0 — verified ground truth

Nothing in this section is assumed. Each claim names the command that produced it.

### WorkOS MCP

Connected over OAuth (not API key — see the finding below).

```
opencode mcp list
  ● ✓ workos connected        https://mcp.workos.com/mcp
  ● ✓ appwrite connected      https://mcp.appwrite.io
```

Live probes (`initialize`, `tools/list`, `tools/call`) against `mcp.workos.com/mcp`:

| Probe | Result |
|---|---|
| `initialize` | `200 {"name":"WorkOS","version":"0.1.0"}` |
| `tools/list` | 4 tools: `whoami`, `list_operations`, `query`, `mutate` |
| `whoami` | Daniel Muhoro · role `ADMIN` · Staging env `environment_01M4DNTBHNBDNXTNHWSQD16CSS` |
| operation index | **188 queries + 183 mutations** (dumped to `artifacts/sprint-25/workos-catalog.md`) |
| `query permissions` | `isEnabledForApiKeys: false` by default — least-privilege default |
| `query radarSettings` | `botDetection: Challenge`, `bruteForceAttack: Block` — fail-closed defaults |

**Zero mutations were run.** Everything above is read-only.

### Appwrite MCP

Connected over OAuth console session.

| Call | Result |
|---|---|
| `tables_db_list` | 1 database → `b2b_software_factory` ("Software Factory"), type `legacy`, status `ready` |
| `tables_db_list_tables` | 4 tables → `tenants`(5 cols), `telemetry_events`(8), `ai_transformations`(12), `audit_logs`(6) |
| `storage_list_buckets` | **0 buckets** |
| `users_list` | **0 users** |
| `organization_list_project_keys` | **0 API keys** |
| `projects_list_stages` | `401 general_access_forbidden` — the console OAuth session cannot read the onboarding checklist |

### Finding: SF's live Appwrite credential is dead

`npm run appwrite:check` fails. It fails *honestly*, and its own diagnostic is correct:

```
endpoint  : https://fra.cloud.appwrite.io/v1
project   : 6aaa99700007bd53480e
database  : b2b_software_factory
api key   : present (not shown)

FAIL  Appwrite call failed (code 401): The API key sent in the X-Appwrite-Key
      header is not valid for this request.
```

Corroborated independently: `organization_list_project_keys` returns `total: 0`. The
267-char key in `.env` does not exist in the project any more — it was deleted or
revoked in the console. **This is operator-blocked**: only the dashboard owner can
mint a replacement with `tables.read/write`, `rows.read/write`, `columns.read`,
`indexes.read/write`, `databases.read`. Rotation cannot fix a missing grant.

The schema itself is intact and correct, so the durable fix is a new key, not a
re-provision.

### Finding: the FRA regional endpoint is flaky from this host

```
10x https://fra.cloud.appwrite.io/v1/health → 9×401 (0.63–2.27s), 1× timeout (12.0s)
10x https://cloud.appwrite.io/v1/health     → 10×401 (0.27–0.74s)
node fetch → fra: ETIMEDOUT   cloud: 401 in 344ms
```

Not a credential problem — the same `curl` succeeds where `undici` times out. SF's
retry ladder already absorbs most of it; the residual is environmental.

### Finding: the static API-key header defeats WorkOS OAuth

Configuring `Authorization: Bearer sk_test_…` on the WorkOS MCP entry made **every**
call return `401 {"error":"unauthorized"}`. WorkOS MCP is OAuth-only; the static
header overrides the stored OAuth token. The header was removed and OAuth took over
immediately. Recorded because it is a non-obvious trap for any remote MCP that uses
OAuth resource indicators.

---

## What is borrowed, and what is deliberately inverted

| Shape borrowed | WorkOS source | SF adaptation |
|---|---|---|
| Two-phase confirm | `mutate.confirmation_token` | irreversible control-plane ops return a token; the second call executes |
| Eligibility pre-check | `workspaceDeletionCheck`, `environmentDeletionEligibility` | ask "may this be destroyed?" *before* attempting it |
| Graduated enforcement | `updateRadarSettingsMode` (`off`/`log-only`/`enforce`) | new gates ship `log-only`, are observed refusing, then enforce |
| Schema-validated audit + preview | `auditLogValidator`, `auditLogSchemaPreview` | validate an event against a versioned schema before it enters the ledger |
| Scoped, expiring keys | `expireApiKey`, `setPermissionsEnabledForApiKeys` | per-key scopes + expiry, enforced at `tenantAuth` |
| Outbound webhooks | `webhookEndpointSecret`, `sendTestWebhook`, `resendWebhookEvent` | HMAC-signed run-lifecycle notifications with test-send and replay |
| Self-describing authz | `whoami` `roleDescription` | `GET /api/whoami` returns capability posture in plain English |

### Two inversions — never borrowed as-is

**1. `upsertActionsEndpoint(failOpen: boolean)` → no switch at all.**

WorkOS lets an authentication hook *fail open*: if the hook times out, the login
proceeds anyway. That is correct for WorkOS — a hung hook must not lock out thousands
of end users. It is catastrophic for SF. The loop's contract is that unverified work
ships. If SF gained a `failOpen` toggle, every one of the 230 tests proving "a gate
refuses ⇒ no commit" would keep passing while the production path silently admitted
unverified work. That is exactly the defect class the Constitution calls *a protection
that can be switched off is not a protection*. **Borrow the shape (typed lifecycle
hooks), delete the switch.** Refusal is the only outcome.

**2. WorkOS in the execution path → enrichment only.**

If a run cannot start unless WorkOS answers, then WorkOS downtime becomes SF downtime,
and a compromise of WorkOS becomes a lever over SF's commits. Availability must not
become a security dependency. **WorkOS stays an enrichment source** — identity claims
and audit egress are additive; the core loop runs with WorkOS unreachable, and no gate
consults it.

---

## Phases

| # | Phase | State |
|---|---|---|
| 0 | Ground truth record | **done** `698f164` |
| 1 | Two-phase confirm on destructive control-plane ops | **done** `5cfb42c` |
| 2 | Eligibility pre-check before destruction | **done** `5cfb42c` |
| 3 | Scoped, expiring API keys at `tenantAuth` | **done** `1bf7e59` |
| 4 | Graduated enforcement (**`off` refused**; `log-only`/`enforce`, default `enforce`) | **done** `9612bf2` |
| 5 | Audit event schema validation + preview | pending |
| 6 | Outbound webhooks (HMAC, test-send, replay) | pending |
| 7 | Resource-scoped RBAC (`principal → role → permission → repo`) | pending |
| 8 | Self-describing authz (`GET /api/whoami`) + panel posture | pending |
| 9 | Evidence, release, tag | pending |

## Risk register

| Risk | Mitigation | State |
|---|---|---|
| Weakening tenant binding while adding scopes | scope checks added *after* the existing binding invariant, never in place of it | open |
| New error code degrading to 500 | every new code enters both `DOMAIN_ERRORS` and `THROWN_CODES`; `L3` asserts none maps to 500 | open |
| A fail-open switch entering the codebase | Phase 4's `off` applies only to *new* gates and must be visibly recorded; no `failOpen` field is permitted anywhere | open |
| WorkOS/Appwrite secrets committed | both live in `~/.local/share/opencode/mcp-auth.json` (mode 600); never copied into the repo | **green** |
| Destructive op on SF's own provisioned database | `b2b_software_factory` is SF's live target (`.env`, `appwrite:provision`); explicitly **not deleted** this sprint | **green** |

## Operator-blocked

1. **Appwrite API key** — project `6aaa99700007bd53480e` has zero keys; the `.env` key
   is refused 401. Needs a console-created key with table/row/column/index scopes.
2. **Onboarding checklist** — `projects_list_stages` is `401` under the console OAuth
   session; completing onboarding is a dashboard action.

## Evidence (as landed)

### Phases 1 and 2 — two-phase cancel + eligibility (`5cfb42c`)

`test/loop-two-phase-cancel.test.ts`, 10 cases, all driving the real
`LoopControlService` and the real HTTP router against a stub provider and real git
repositories:

- the token is single-use, and a replay is refused even inside the TTL;
- a token bound to one subject or tenant cannot redeem another;
- **a wrong guess invalidates a live confirmation**, so it cannot be brute-forced;
- an expired token is refused;
- **a single call does not cancel** — phase one takes no action on the run;
- a real cancellation stops the run at a unit boundary and is recorded as a hard
  stop naming the operator, with no unit left running;
- a forged or missing token is refused and leaves the run running;
- a foreign tenant gets a miss, and so does its cancellation;
- a settled run is not cancelable;
- over HTTP: 202 + token on phase one, 202 + `cancellationRequested` on phase two,
  400 on replay, 404 cross-tenant, 401 with no credential, and the eligibility
  pre-check answers `eligible: false` once the run has settled.

**Failing-first proof.** With `requestCancel` patched to call
`ExecutionLoopService.requestCancellation` immediately (the single-phase behaviour
the shape exists to prevent), case 5 fails:

```
not ok 5 - a single call does not cancel: phase one takes no action on the run
# pass 9
# fail 1
```

Reverted, and the file returns to 10/10.

### Regression

- `npm test` → **240/240** passing (230 baseline + 10 new).
- `npm run lint` (`tsc --noEmit`) clean.
- `npm run build` (vite + esbuild) clean.

### Also fixed this sprint

`da90cfe` — the 4.12.0 release bumped `package.json` but left `package-lock.json`
at 4.11.0, failing NC-3. A release that cannot be installed from a clean clone is
not a release.

### Phase 3 — scoped, expiring credentials (`1bf7e59`)

`test/scoped-credentials.test.ts`, 10 cases, every one driving the real
`tenantAuthMiddleware` over HTTP. A scope check that only runs in a unit test is not a
scope check.

- the scope requirement is derived from the request and is a closed set
  (`loop:read`, `loop:write`, `admin`). **Anything that is not a recognised loop route
  demands `admin`**, so adding a route denies every scoped key until someone grants a
  matching scope on purpose.
- a read-scoped key is refused a write at the boundary with `CREDENTIAL_SCOPE_INSUFFICIENT`;
  the root credential is not narrowed.
- an expired key answers `SCOPED_CREDENTIAL_EXPIRED`, a revoked one
  `SCOPED_CREDENTIAL_REVOKED`; a key matching nothing stays a silent `UNAUTHORIZED`, so a
  caller cannot probe which tenants hold scoped keys.
- revoking one key leaves its siblings and the root working; a second revocation is a no-op.
- **the cancellation route is guarded by the scope check, not beside it**: reading the
  eligibility of a cancel is a loop read and reaches the handler; performing it is a loop
  write and is refused before the handler runs.

**Failing-first proof.** With the boundary check disabled in `tenantAuthMiddleware`, three
cases fail — `limited to its scopes`, `the root credential is not narrowed`, and `the
cancellation route is guarded by the scope check` — recorded by running it that way and
reverting.

### Phase 4 — graduated enforcement (`9612bf2`)

The inversion. WorkOS ships `upsertActionsEndpoint(failOpen)`; SF does not borrow it.

`src/utils/enforcement.ts` has **two** members, not three. `off` is not a value the type
can hold — it is a value the parser refuses, in every environment, because a bypass that
only works in development is a bypass that reaches production through a copied `.env`.
Anything unrecognised resolves to `enforce`, so a typo cannot silently disable a check.
`log-only` records what it would have refused, attributed to a named rule.

Governed checks are advisory only. A hard safety gate has no mode and is not consultable
through this module.

**Failing-first proof.** With the refusal disabled, `every spelling of off is refused, in
every environment` fails, recorded by running it that way and reverting.

### Regression after phases 3 and 4

- `npm test` → **257/257** passing (230 at sprint-24 close + 27 new).
- `npm run lint` (`tsc --noEmit`) clean; `npm run build` clean.
