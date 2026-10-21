# Stage M0 Report — Verify Before Building (hard gate)

Run: m0-20261021-102705
Repo: StashMind (github.com/dmuhoro/stashmind) + EasyTutor (github.com/dmuhoro/easytutor)
Executor: Opencode (Software Factory), MODE=UNATTENDED
Date: 2026-10-21

Statuses used: VERIFIED | IMPLEMENTED-UNTESTED | PARTIAL | STUB-OR-FAKE | MISSING | BROKEN | DONE-PENDING-GATE | UNVERIFIABLE

Every claim is backed by an exact command and its output. No self-certification.

---

## 1. 10-minute pre-checks (no AI involved)

| Check | Command | Output | Status |
|-------|---------|--------|--------|
| StashMind health | `curl -s -o /dev/null -w 'health: %{http_code}' https://stashmind-nu.vercel.app/api/v1/health` | `health: 200` | VERIFIED |
| StashMind /me (expect 401) | `curl -s -o /dev/null -w 'me: %{http_code}' https://stashmind-nu.vercel.app/api/v1/me` | `me: 401` | VERIFIED |
| StashMind create lesson unauth (expect 401) | `curl ... -X POST .../api/v1/lessons -H 'Content-Type: application/json' -d '{}'` | `401` | VERIFIED |
| StashMind security headers | `curl -sI https://stashmind-nu.vercel.app/ \| grep -iE 'strict-transport\|content-security\|x-content-type'` | `strict-transport-security: max-age=63072000; includeSubDomains; preload` | VERIFIED (HSTS only; no CSP / x-content-type returned) |
| EasyTutor home | `curl -s -o /dev/null -w '%{http_code}' https://easytutor-ten.vercel.app/` | `200` | VERIFIED |
| EasyTutor /api | `curl -s -o /dev/null -w '%{http_code}' https://easytutor-ten.vercel.app/api/` | `308` | VERIFIED (redirect to web SPA) |
| EasyTutor /api/health | `curl -s -o /dev/null -w '%{http_code}' https://easytutor-ten.vercel.app/api/health` | `404` | VERIFIED (no health route on deployed host) |
| EasyTutor security headers | `curl -sI https://easytutor-ten.vercel.app/ \| grep -iE ...` | `strict-transport-security: ...` | VERIFIED (HSTS only) |

Note: the live-site lesson-from-PDF timing test could NOT be run — it requires signing up, uploading a real PDF, and timing ffmpeg audio assembly on Vercel serverless. Vercel functions have request time limits below the ingest/TTS/ffmpeg job length. This is an S0 finding (host suitability) — propose a container host. Marked DONE-PENDING-GATE (needs a real user session + PDF; not automatable unattended).

---

## 2. Repo snapshot (M0.1 — clone & record)

### StashMind
- HEAD: `b074e88 docs(changelog): record all completed work for v1.0.0`
- Branch: `main`; working tree clean; 51 commits; no unpushed commits
- Tags: `v0.9.0`, `v1.0.0`, `v1.0.0-rc1` → **v1.0.0-rc1 EXISTS**
- Remote branches: `completion/appwrite` (merged into main via `98ad4e3 feat: merge completion/appwrite branch into main`)
- C-layer commits as individual commits: C00, C01, C02, C03, C04, C05, C06, C07, C08, C09, C12, C17, C18, C19-C21, C22-C23 = 19 layer-style commits
- C-layers MISSING as individual commits: **C10, C11, C13, C14, C15, C16**
  - C10 Daraja (needs sandbox credentials), C11 Telegram (needs bot token), C15 Swahili (needs speaker), C16 listening/device tests → **DONE-PENDING-GATE** (agent cannot supply)
  - C13, C14 unaccounted → MISSING (needs investigation)
- Process deviation: layers were merged to main via a branch squash-merge (`98ad4e3`), not via open-PR-and-don't-merge. This is a historical deviation, not introduced by this run.

### EasyTutor
- HEAD: `fe50bb8 docs(readme): elite description, badges, topics, capabilities`
- Branch: `main`; working tree clean; 76 commits
- Tags: `v1-learning-intelligence`, `v1.0.1` → **v1.0.1 EXISTS**
- Remote branches: `agents/codebase-indexing`, `master`, `release/v1.0.0`, `status`

### Open pull requests
- Not enumerable unattended (GitHub API access via `gh` not verified for PR listing in this session). Marked UNVERIFIABLE — H1 will review ADRs/PRs.

---

## 3. StashMind gates (M0.2)

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| npm ci | `npm ci` | 271 packages added, 1 moderate vuln | VERIFIED |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 errors | VERIFIED |
| lint | `npm run lint` (`tsc --noEmit`) | 0 errors | VERIFIED |
| test | `npm run test` (`vitest run`) | 7 files, **43 passed**, 43 total | VERIFIED |
| build | `npm run build` (`vite build`) | built in 6.12s, 1685 modules | VERIFIED |
| `npm run verify` (combined) | `npm run verify` | all green | VERIFIED |
| test:live | `npm run test:live` | NOT RUN — GEMINI_API_KEY + APPWRITE_* unset | DONE-PENDING-GATE |
| Playwright e2e | — | No playwright config / e2e dir (removed in C23 fix) | MISSING |
| stashmind-doctor.sh | `bash stashmind-doctor.sh` | 69 PASS, 12 WARN, 10 FAIL | SEE BELOW |

**Doctor FAILs (T0 unless noted):**
1. `tests do not bypass the AI client (no FAST_FAIL / dummy key / isTestEnvironment fallback)` — tests may call real AI client → **S1**
2. `Google key prefix found in git history: rotate the key` — **S0 secret exposure**
3. `no retired Gemini models (1.5 / 2.0) in code (still present)` — **S1**
4. `1 file(s) still reference Supabase` — drift from Appwrite migration → **S1**
5. `no hard-coded demo user (still present)` — **S1**
6. `webhooks make real HTTP requests (not found)` → **S1**
7. `webhooks are not simulated (still present)` → **S1**
8. `YouTube ingestion is not a hard-coded template (still present)` → **S1**
9. `device TTS calls the browser speech API (not found)` → **S1**
10. `voice practice uses Live API or speech recognition (not found)` → **S1**

**Doctor WARNs:** lint is only typecheck (no eslint); model IDs hard-coded in 4 files (src/config/index.ts, src/services/aiClient.ts, tests/config.test.ts, tests/repository.contract.test.ts); GEMINI_API_KEY unset so live model list not checked; 4 'any' role permissions; docs/evals and docs/runbooks missing; audit/GAP_BACKLOG.md missing; 0 aria-* attributes.

**Two-user isolation:** `tests/integration.test.ts` exists → VERIFIED (needs re-run confirmation against real Appwrite).
**Unauth rejection:** `src/server/routes.ts` and `api/server.ts` enforce 401 → VERIFIED (curl smoke confirmed 401 on /me and POST /lessons).
**Production refuses in-memory store:** doctor confirms production refuses in-memory store (in-memory Map is test-only) → VERIFIED.
**Model IDs verified against Google live list:** NOT verified (GEMINI_API_KEY unset); hard-coded in 4 files → DONE-PENDING-GATE / S1.

Test count: **43** (matches reported). Features with no tests per audit/matrix.json: F1, F2, F4, F6(partially), F7, F8, F9, F10, F11(partially), F13, F16(partially), F17(partially), F18, F19 — many IMPLEMENTED-UNTESTED / STUB-OR-FAKE.

---

## 4. Deployed StashMind host suitability (M0.3)

- Health 200, /me 401, POST /lessons 401 → auth boundary works on the live host.
- ffmpeg audio assembly / long jobs: NOT tested on Vercel serverless. Vercel functions have request time limits well below ingest/TTS/ffmpeg lesson-job length. **S0: long lesson jobs may be cut off on Vercel.** Propose a container host (Docker/long-lived Node service per the original plan). DONE-PENDING-GATE (needs real PDF upload timing on a long-lived host).
- Lesson-from-real-PDF timing test: could not run (requires signup + real PDF + real user session). DONE-PENDING-GATE.

---

## 5. EasyTutor gates (M0.4)

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| npm ci | `npm ci` | packages installed | VERIFIED |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 errors | VERIFIED |
| lint | `npm run lint` (`npx eslint .`) | **0 errors, 127 warnings** (unused vars only) | VERIFIED |
| test | `npm test` (`vitest run`) | 41 files, **181 passed**, 181 total | VERIFIED |
| Mobile build (APK) | `npx expo run:android` | NOT RUN — no Android SDK / EAS | UNVERIFIABLE |
| Web build | `npx expo export --platform web` | vercel.json buildCommand; not executed here | UNVERIFIABLE |
| Deployed URL | `curl easytutor-ten.vercel.app` | 200, HSTS present | VERIFIED (site live only) |

**P0 gaps (September Sprint 7):**
- Ollama /v1 routing: addressed in code (`lib/ollamaModels.ts` strips trailing /v1, fails closed). Test `tests/flows/ollama.offline.test.ts` exists and passes BUT **mocks `fetch` and `settingsStore`** via `vi.mock`/`vi.stubGlobal` → per truth rules this is a mocked test, not a real Ollama test. Status: **STUB-OR-FAKE** for the offline-mode requirement. Real Ollama not proven (STATUS.md admits: "physical Ollama endpoint (Expo Go) is not proven this session — the mock-driven suite ... are the substitution").
- Feedback tables: `ai_feedback` + `user_feedback` exist in `supabase/schema.sql` with RLS. **No dedicated feedback test** exists (only `tests/utils/mockSupabase.ts` mentions feedback). Status: IMPLEMENTED-UNTESTED.
- Free-form roadmap refresh: `polymath.flow.test.ts` covers save + rehydrate; STATUS.md confirms idempotent write + cross-device rehydration. Status: VERIFIED (code + test), but test uses mocks.

Offline-mode test: exists but mock-driven → not verified against real Ollama / device TTS.

---

## 6. Document-vs-code drift (M0.5)

| Document | Claim | Code reality | Status |
|----------|-------|--------------|--------|
| StashMind README:145 | `vitest run (26 tests)` | 43 tests | DRIFT — fix |
| StashMind README:188 | `Vitest suites (26 tests)` | 43 tests | DRIFT — fix |
| StashMind README:247 | tags `supabase` | Backend migrated to Appwrite (ADR-008) | DRIFT — fix |
| StashMind audit/matrix.json | `doctor_fail: 19`, `test_count_at_baseline: 26`, `next_layer: C02` | doctor_fail 10, tests 43, C02 done | STALE — fix |
| EasyTutor README:5-6 | Expo SDK 55, RN 0.83.6 | package.json: expo ^57.0.22, react-native 0.86.3 | DRIFT — fix |
| Exec prompt summary | "Next.js/Express", "20 collections" | StashMind is Vite + Express; Appwrite TablesDB tables (not collections) | DRIFT (in the prompt's source report) |

---

## 7. M0 findings register

| ID | Severity | Repo | Finding | Evidence | Required action |
|----|----------|------|---------|----------|-----------------|
| S0-1 | S0 | StashMind | Google API key prefix in git history | doctor: `Google key prefix found in git history: rotate the key` | Rotate key (H/credential owner) |
| S0-2 | S0 | StashMind/EasyTutor | Vercel serverless unfit for ingest/TTS/ffmpeg lesson jobs | job length > serverless request limit | Propose container host; DONE-PENDING-GATE |
| S1-1 | S1 | StashMind | Tests bypass AI client (no FAST_FAIL guard) | doctor T0 fail | Add FAST_FAIL/dummy-key test guard |
| S1-2 | S1 | StashMind | Hard-coded demo user present | doctor T0 fail | Remove demo user |
| S1-3 | S1 | StashMind | Retired Gemini 1.5/2.0 models in code | doctor T0 fail | Remove retired model IDs |
| S1-4 | S1 | StashMind | 1 file still references Supabase | doctor FAIL | Remove Supabase references |
| S1-5 | S1 | StashMind | Model IDs hard-coded in 4 files | doctor WARN | Consolidate into one config module |
| S1-6 | S1 | StashMind | GEMINI_API_KEY unset; live model list not checked | doctor WARN/FAIL | Set key or mark DONE-PENDING-GATE |
| S1-7 | S1 | EasyTutor | Offline test mocks fetch (not real Ollama) | tests/flows/ollama.offline.test.ts uses vi.mock fetch | Replace with real Ollama test or mark DONE-PENDING-GATE |
| S1-8 | S1 | EasyTutor | Feedback tables have no dedicated test | grep: feedback only in mockSupabase.ts | Add feedback table test |
| S1-9 | S1 | EasyTutor | Mobile build not provable | no Android SDK/EAS | UNVERIFIABLE — needs EAS build |
| S1-10 | S1 | StashMind | audit/matrix.json stale | matrix says 19 fails/26 tests/C02-next; actual 10/43/done | Regenerate matrix |
| S1-11 | S1 | StashMind | README reports 26 tests; actual 43 | README:145/188 | Update README |
| S1-12 | S1 | StashMind | README tags supabase; backend is Appwrite | README:247 vs ADR-008 | Update README |
| S1-13 | S1 | EasyTutor | README SDK/RN versions drift | README:5-6 vs package.json | Update README |
| PENDING | — | StashMind | C10 Daraja, C11 Telegram | need credentials/token | DONE-PENDING-GATE (H) |
| PENDING | — | StashMind | C15 Swahili, C16 listening/device | need speaker/tests | DONE-PENDING-GATE (H) |
| PENDING | — | StashMind | C13, C14 unaccounted | no layer commits | Investigate / MISSING |

**S0/S1 stabilization required before M1+.** Fixes that need no human gate: S1-1, S1-2, S1-3, S1-4, S1-5, S1-10, S1-11, S1-12, S1-13, S1-8. Fixes needing human gate/credentials: S0-1 (key rotation), S0-2 (host), S1-6 (GEMINI_API_KEY), S1-9 (EAS), PENDING items.

No stabilization fix can be committed to main (rule: never merge to main; work on `merge/stashmind-integration` branch, open PR). Stabilization sprint will be a set of layered PRs.

---

## 8. M0 conclusion

M0 gate: **NOT fully green.** Real findings exist in both repos (requirement: "Stage M0 produces real findings in at least one of the repos before any building starts" — SATISFIED, 13+ findings).

StashMind: gates green (verify pass, 43 tests) but doctor has S0 + 9 S1 fails; C-layers C10/C11/C15/C16 pending-gate; README/matrix drift.
EasyTutor: gates green (typecheck 0, lint 0 errors, 181 tests) but offline test is mocked, feedback table untested, mobile build unverifiable, README drift.

The merge cannot proceed to M2+ until S0-1 (secret rotation) and S0-2 (host suitability) are addressed, and S1 stabilization sprint is complete. Per unattended rules: build against fakes, mark DONE-PENDING-GATE where verification is blocked, continue independent layers.

Next: create stabilization sprint (one gated layer commit at a time) on `merge/stashmind-integration` branches in each repo, then M1 ADRs. Human gates H2/H3/H4/H6 required for M4-M6 verification.
