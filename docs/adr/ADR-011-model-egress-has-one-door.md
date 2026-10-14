# ADR-011: Model egress has one door

- **Status**: Proposed — awaiting founder sign-off (Sprint 29, WP-0)
- **Date**: 2026-10-14
- **Resolves**: the unguarded `@google/genai` egress path (a second door beside
  `src/utils/egressGuard.ts`)
- **Supersedes**: nothing (narrows ADR-002; see the tension below)

## Context

`src/utils/egressGuard.ts:1-19` states its own role in the first four lines: it is the "single
authority for 'may the factory send a request here, and may it attach a secret?'". The guard
exists because of a proven vulnerability — model providers once accepted a caller-supplied
`secretRef` and `baseUrl`, resolved the first against the server's environment, and sent the
result to the second as a bearer token, so any API key holder could read any secret in the
process (`frontierModelService.ts:24-31` records the fix; `egressGuard.ts:6-13` records why).

There are **two** doors today, not one.

1. **The guarded door.** `src/utils/egressGuard.ts` exports `resolveSecretRef`,
   `validateProviderUrl`, and `egressJson`, which validate the secret reference against
   `FACTORY_ALLOWED_SECRET_REFS` (`egressGuard.ts:59-80`), the host against
   `FACTORY_MODEL_ALLOWED_HOSTS` (`:51-53`, `:172-176`), and the resolved address against blocked
   ranges at the socket (`:179-196`). It has exactly three callers: `frontierModelService.ts:2`,
   `prFlowService.ts:16`, and `issueTrackerService.ts:17`.

2. **The unguarded door.** `src/services/geminiService.ts` imports the vendor SDK directly
   (`:6`), reads the key with `process.env.GEMINI_API_KEY` (`:23`), constructs the client
   (`:28-35`), and calls `client.models.generateContent` (`:104`). It never imports the guard.
   It is not vestigial: it is the live telemetry-enrichment path,
   `pipelineOrchestrator.ts:131-139`, required by Constitution Article II.

The two doors are **disjoint**. The guarded door cannot answer Gemini at all:
`frontierModelService.ts:78` refuses `kind: 'gemini-native'` with
`MODEL_PROVIDER_REQUEST_UNSUPPORTED`. So any live Gemini call necessarily leaves through the
unguarded door.

There is a **third** site, `appwrite-functions/gemini-orchestrator/index.js:17,23,27,291`, which
also reads `process.env.GEMINI_API_KEY` and calls Gemini. It is a separate deployable with a
separate trust boundary (an Appwrite serverless function, not this process), so it is **out of
scope** for this ADR — named here so it is not silently overlooked.

### The ADR-002 tension, stated plainly

ADR-002 ("Gemini Structured Output Schema Enforcement via `@google/genai`") standardizes on the
official `@google/genai` SDK and its `Type` enum for schema construction. Constitution Article
VI.5 (adopted) says "No file outside that package [the single provider abstraction] may import a
vendor SDK directly." These are in tension for Gemini: ADR-002 names the SDK; Article VI.5
forbids importing it raw.

The tension is resolvable because the two say different things. ADR-002 governs **schema
construction** — how a structured, schema-validated response is requested. It does not grant
**transport authority** — which host may be reached and which secret may be attached. Those belong
to the guard. ADR-011 narrows ADR-002: the SDK stays the schema builder; the guard owns the secret
and the host.

## Decision

**Recommended: fail-closed routing through the guard. One door.**

1. **Every outbound model or telemetry request passes `egressGuard`.** The secret is resolved by
   `resolveSecretRef` (an allowlisted reference present in `FACTORY_ALLOWED_SECRET_REFS`), and the
   host is permitted (`FACTORY_MODEL_ALLOWED_HOSTS`) and address-checked. A call that cannot
   satisfy both refuses; it never falls back to a live unguarded request.

2. **The SDK is the schema builder, not the transport authority.** `@google/genai`'s `Type` enum
   may still construct `responseSchema` (preserving ADR-002 and Article II). The key it is given
   must come from `resolveSecretRef`, and the endpoint it reaches must be a permitted host. Where
   the SDK owns its own socket, the guard is applied by validating the configured base URL and the
   secret before the SDK is constructed, and by asserting the configured base URL is the
   allowlisted endpoint — the same name-and-address checks the guarded door performs.

3. **An architectural assertion is required, not optional.** A test must fail if a vendor model
   SDK or a raw network client (`node:https`, `node:http`, `undici`, bare `fetch`) is used for
   model egress outside the sanctioned boundary, or if a provider secret is read outside
   `resolveSecretRef`. Per ADR-008, a control that is not asserted is a comment; without this test
   ADR-011 is a comment.

4. **The labelled fallback is not a live call.** `geminiService.ts:63-83` returns a deterministic
   *synthetic* output, labelled as such, with `tokensUsed: 0`, when no key is mounted. That is
   honest and stays. What must not happen is that the absent-key path becomes the reason an
   unguarded *live* call is made elsewhere.

## Consequences

- WP-2 (Sprint 29) implements this ADR and flips its status from **Proposed** to **Accepted** in
  the same change that lands the code (Constitution Scope rule 2). The mechanism — whether the
  SDK's configured endpoint is validated, or `gemini-native` becomes a transport inside
  `egressJson` (`frontierModelService.ts` currently refuses it at `:78`) — is WP-2's design. This
  ADR fixes the invariant, not the mechanism.
- Concretely honest about the current gap: today `pipelineOrchestrator.ts:131` reaches Google
  through a path that never consults `FACTORY_ALLOWED_SECRET_REFS` or `FACTORY_MODEL_ALLOWED_HOSTS`.
  An operator who believes those allowlists fence all model egress is only half right. This ADR
  names that, which is the point.

## Alternatives rejected

**Leave the legacy path and document it.** Rejected. A documented second door is still a second
door, and ADR-008 is explicit: a control that is not asserted is a comment. The unguarded path is
the one on the live telemetry route.

**Remove `GeminiService` and the `@google/genai` dependency.** Rejected as the default. Article II
requires Gemini structured outputs on the live telemetry path; removing the service removes a
required capability rather than securing it. It remains available as Option C if the founder
prefers to consolidate Gemini onto the provider abstraction instead.

**Read the key with `process.env` directly and only add a host check.** Rejected. The key is the
exfiltration asset the guard is built to protect; resolving it outside `resolveSecretRef` bypasses
the allowlist that is the whole control.

**Treat the Appwrite function as in scope.** Rejected for this ADR. It is a different deployable
with a different environment and trust boundary; folding it in would claim coverage this change
does not provide.

## Options presented for sign-off

- **Option A (recommended): route through the guard.** Keep `@google/genai` for schema
  construction (ADR-002 preserved); resolve the key via `resolveSecretRef` and validate the host
  via the guard; refuse when not allowlisted. WP-2 implements.
- **Option B: fence the legacy path.** Declare `GeminiService` the deprecated/legacy path, gate it
  behind an explicit operator flag, and move the live telemetry path onto the guarded provider
  abstraction. Documented as a limit rather than an invariant.
- **Option C: remove it.** Delete `GeminiService` and the direct `@google/genai` use; Article II's
  capability moves wholly onto the guarded provider path (which must first learn to answer
  Gemini — `frontierModelService.ts:78`).
