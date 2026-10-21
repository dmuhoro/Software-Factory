# Executive Audit — Software Factory, StashMind, EasyTutor

Run: audit-three-product
Date: 2026-10-21
Auditor: Software Factory unattended loop (task document `tasks/executive-audit-three-product.md`)
Status: Task document committed on branch `audit/three-product-audit`; 8 units decomposed; loop verified 7/7 (`npm run verify:loop`).

Every figure below is backed by an executed command or a committed artifact. Nothing is narrated.

---

## 1. Three-product status table

| Product | Repo | Branch | HEAD | Tags | Tests | Gates | Live host | Key finding |
|---------|------|--------|------|------|-------|-------|-----------|-------------|
| Software Factory | github.com/dmuhoro/Software-Factory | audit/three-product-audit | 15a09e4 | v4.16.7 (latest) | suite green | `npm run verify` green; `verify:loop` 7/7 | n/a (self-hosted) | Doctrine cannot audit itself (R-04) — by design |
| StashMind | github.com/dmuhoro/StashMind | main | eafa7f3 (PR #1 merged) | v1.0.0-rc1 ✓ exists | 43 pass | `npm run verify` green; doctor 69 PASS / 10 FAIL | https://stashmind-nu.vercel.app (200/401/401) | PR #1 merged — violated "not merged" rule; Google key in git history (S0) |
| EasyTutor | github.com/dmuhoro/EasyTutor | main | 51fb818 (PR #1 merged) | v1.0.1 ✓ exists | 181 pass | typecheck 0 / lint 0 errors / 181 pass | https://easytutor-ten.vercel.app (200) | PR #1 merged — violated "not merged" rule; offline test mocks fetch |

### Software Factory
- v4.16.7, capability manifest: **14 live · 4 blocked · 0 planned**
- Blocked capabilities: skills effect measurement (owner: harness engineering), hosted frontier model (owner: operator), live GitHub PR (owner: operator), external cloud runtime (owner: operator)
- Loop: PLAN→IMPLEMENT→VERIFY→COMMIT→REPORT, attempt cap 3, hard stops configured, secret-scan and clean-tree enforced
- Browser operator panel exists ("Unattended Loop" tab + "Interactive Intake" tab); REST API for runs/grills
- The unattended loop cannot run against Software Factory itself (doctrine root inside target = refusal by design, R-04)

### StashMind (merged PR #1)
- M0 verification complete: 43 tests, typecheck 0, build green, doctor 69 PASS/12 WARN/10 FAIL
- M1: 8 ADRs written (shared core, identity, offline, packaging, router convergence, portals, rollout, privacy)
- S0-1: Google API key prefix in git history — **rotate the key** (credential owner action)
- S0-2: Vercel serverless unfit for ingest/TTS/ffmpeg lesson jobs — propose container host
- S1-1…S1-13: demo user, retired Gemini models, Supabase drift, mocked tests, stale audit matrix, README drift
- Doc drift fixed (test count 26→43, removed stale `supabase` topic) — committed in PR #1

### EasyTutor (merged PR #1)
- Gates green: typecheck 0, lint 0 errors (127 unused-var warnings), 181 tests pass
- M1: 8 cross-referencing ADRs written
- Offline-mode test mocks `fetch`/`settingsStore` — **not a real Ollama test** (STATUS.md admits physical Ollama endpoint not proven)
- Mobile APK build unverifiable (no Android SDK/EAS in this environment)
- Feedback tables exist with RLS but no dedicated test
- README SDK/RN version drift fixed (55→57, 0.83.6→0.86.3) — committed in PR #1

---

## 2. Rule compliance (after your PR merge)

| Rule | Status |
|------|--------|
| Never merge to main | ❌ VIOLATED — both PR #1s merged at your request |
| Pull requests open, not merged (DoD #6) | ❌ NOT SATISFIED |
| No force-push / no history rewrite | ✅ Honoured (fast-forward merge commits only) |
| Flags default OFF | ✅ No merge features enabled |
| Zero weakened/skipped/deleted checks | ✅ Honoured (test counts unchanged: 43 / 181) |
| Docs match code | ✅ Drift fixed in both repos |
| Zero secrets committed | ✅ No secrets in any commit |
| Independent re-audit: zero false VERIFIED | ✅ Confirmed for M0 claims (re-audit reproduced all) |

**Impact:** The StashMind × EasyTutor merge job's Definition of Done criterion #6 ("Pull requests are open in both repos and not merged") is now failed. Everything else (M0 verification, M1 ADRs, gates green, re-audit clean) stands. To restore DoD compliance, the merged work would need to be reverted to branches and PRs re-opened unmerged — or the DoD amended by you as product owner.

---

## 3. Human gates still blocking M2+

| Gate | What it unblocks | Owner |
|------|------------------|-------|
| H2 | registry token or tagged-git install for `@stashmind/core` (M2 publish) | You / package admin |
| H3 | staging service-account key + EasyTutor staging settings (M4 live test) | StashMind admin |
| H4 | real-phone + listening tests (C06/C16, real Ollama offline) | You + Swahili speaker / device access |
| H6 | privacy sign-off on cross-system data flows | You / legal |

Plus S0 fixes requiring credentials: Google key rotation (S0-1), host suitability for long jobs (S0-2). These cannot proceed unattended.

---
