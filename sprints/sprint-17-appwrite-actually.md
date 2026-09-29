# Sprint 17 — Appwrite, Actually

**Status:** complete · **Date:** 2026-09-29

Follows `docs/CONSTITUTION.md` and ADR-006. Released within 4.8.0.

---

## What this sprint found

The directive was to connect the product to Appwrite. Before writing a line, the existing
integration was read. It does not exist.

```ts
// src/configurations/appwrite.config.ts, as shipped
endpoint: process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1',
projectId: process.env.APPWRITE_PROJECT_ID || 'b2b_software_factory_proj',
apiKey:    process.env.APPWRITE_API_KEY    || 'standard_appwrite_api_key_secret',
```

Three failures, all failing open:

1. **`standard_appwrite_api_key_secret` is shaped like a real Appwrite key.** An operator
   scanning the configuration sees a plausible credential and concludes the integration is done.
   This is the same defect class as the `GEMINI_API_KEY` → `TEST_KEY` default hardened in
   4.7.0, which returned invented data that asserted `complianceVerified: true`.
2. **`b2b_software_factory_proj` is a fabricated project id.** No such project exists.
3. **The endpoint defaulted to the global `cloud.appwrite.io`**, not the regional endpoint this
   deployment uses — so a missing variable silently sent tenant telemetry to the wrong
   jurisdiction.

Worse, `AppwriteService` — the class named after Appwrite — **performs no HTTP request and
imports no SDK**. Its own docstring calls it a *"port for founder mode and future Appwrite
replacement"*. Every method writes to the local `DurableStore` file ledger. So:

- the Rust runtime **refused to start** without `APPWRITE_API_KEY` (hardened in 4.7.0),
- the TypeScript configuration **invented** `APPWRITE_API_KEY`,
- and **neither** contacted Appwrite.

The two halves of the same product disagreed about whether the integration was required, and
`AppwriteConfig` was exported through a barrel that nothing consumed — so no test, type, or
import graph would ever have revealed it. Naming is not integration, and a service that
impersonates a dependency is worse than one that admits it has none.

---

## What was built

| Piece | What it does |
|---|---|
| `src/configurations/appwrite.config.ts` | Rewritten. No default for any credential or project id. Reports what is missing, refuses placeholder values, validates the endpoint shape. |
| `src/services/appwriteClient.ts` | **Did not exist.** A real `node-appwrite` 29.0.0 client plus a live reachability check that makes an authenticated call and reports what happened. |
| `scripts/check-appwrite.ts` | `npm run appwrite:check` — the only command that can honestly claim the integration works, because it is the only one that makes a real call. |
| `test/appwrite-integration.test.ts` | 8 tests, including a source-level guard against the defect's return. |

The SDK was installed with `npm install node-appwrite@latest` → **29.0.0, 0 vulnerabilities**,
and the current non-deprecated params-object API is used (`TablesDB.listRows({...})`); the
positional overload is marked `@deprecated` in the SDK's own typings.

---

## Evidence that the integration is real

The one piece of live evidence obtainable without a credential. Run with the **real** endpoint
and **real** project id and a deliberately invalid key:

```
FAIL  Appwrite refused the call (code 401):
      The current user is not authorized to perform the requested action.
```

A real HTTP 401 from `fra.cloud.appwrite.io` proves, in one call, that DNS resolves, TLS
completes, the SDK is wired to the right service object, and the project id is being sent —
because Appwrite parsed the request and refused it on authentication. Nothing mocked, nothing
assumed. The only missing piece is the credential.

Unconfigured, the same command exits 1 and says so:

```
FAIL  not attempted -- APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY must all be set
```

---

## Two bugs the tests caught in the new code

Recorded because the tests earned their keep immediately, and because the first is a fail-open
in the very function written to prevent fail-open behaviour.

**1. `requireAppwriteConfig` did not throw when `NODE_ENV` was unset.** It filtered issues to
`severity === 'error'`, and the development branch downgrades missing configuration to
`warning` — so under a non-production `NODE_ENV` it returned an empty, unusable settings object
instead of throwing. Severity governs *reporting*; requiring is absolute. Now keyed on
`configured`, and an unconfigured call throws with every reason listed at once.

**2. Document ids exceeded Appwrite's limit.** `documentIdFor` delegated to
`DurableStore.deterministicId`, which returns 42 characters; Appwrite caps document ids at 36
and would have rejected every one. Caught by asserting the limit, which the type checker cannot
do. The delegation stays canonical and the result is truncated to 36.

A third problem was self-inflicted: the first `documentIdFor` introduced its own NUL join,
duplicating a rule that already has a canonical home in `durableStore.ts` — where the NUL is
load-bearing. Delegating is shorter and the only version that stays correct if the canonical
function ever changes.

---

## The guard, and the fourth time this lesson arrived

The source-level guard originally searched for the literal placeholder string. It fired on two
things that were not defects: this test file, which names the defect on purpose, and the
docstring in `appwrite.config.ts` that quotes the old code so a future reader understands why.

The lesson from ADR-008 rule 4 — *a check must read instructions, not prose* — has now been
learned the hard way four times in this release, in four different gates. The guard now matches
the defect's **shape** (`process.env.APPWRITE_X || 'literal'`) rather than its text, with
comment lines stripped first.

Negative control, observed failing: reintroducing
`trimmed(env.APPWRITE_ENDPOINT) || 'https://cloud.appwrite.io/v1'` on a code line → the guard
fails, naming the file. Comment lines are stripped because source code executes and a docstring
does not.

---

## Not verified

- **No authenticated call has been made.** A 401 proves the plumbing; it does not prove the
  schema exists, that the four expected tables are present, or that a write succeeds. That
  needs a real API key.
- **The database and tables have not been provisioned.** `b2b_software_factory` with tables
  `tenants`, `telemetry_events`, `ai_transformations`, `audit_logs` are *expected*, reported by
  the check as expectations, and not created. Nothing in this sprint creates infrastructure.
- **Persistence still uses the local durable store.** The adapter exists and is verified to be
  real; switching the product's write path to Appwrite is the next layer, and it is a decision
  with consequences (see *Not decided* below).
- **Appwrite MCP is configured but not connected.** `mcp.appwrite.io` was merged into
  `~/.config/opencode/opencode.json` with all existing entries preserved. It authenticates by
  OAuth in a browser, and MCP tools load only after an OpenCode restart, so no `appwrite_*` tool
  was callable in the session that wrote this file.
- **The Appwrite CLI is installed (28.1.0) but not signed in**, and `appwrite client` has not
  been pointed at the project. Both require a browser approval.

---

## Not decided

Two questions were not answered by this sprint because answering them wrongly is expensive and
the answer belongs to the operator, not to the agent:

1. **Should Appwrite become the system of record, or remain an adapter?** It is currently a
   read/write adapter for telemetry beside a single-writer file ledger. Making it canonical
   would move every document and would interact with NC-2, which is unsolved by design.
2. **Is the local durable store still wanted at all?** The product has two persistence stories
   and no ADR has ever chosen between them.

---

## Commits

This sprint is three commits: the fail-closed configuration, the real client and its tests, and
the verification command.
