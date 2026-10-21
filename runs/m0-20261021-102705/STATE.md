# Software Factory run state — StashMind x EasyTutor Merge (Tier 2)

run_id: m0-20261021-102705
mode: UNATTENDED
executor: Opencode
stage: M0 complete; M1 complete; M2+ BLOCKED on human gates
date: 2026-10-21

## Environment & capabilities
- Shell: bash (GNU Linux Xecuterr 7.0.0-38-generic, x86_64)
- git: 2.53.0 (user: dmuhoro, gh credential helper, repo scope token)
- node: v22.22.1, npm: 11.12.1
- docker: 29.1.3 (present)
- curl/jq: present
- network: GitHub reachable; stashmind-nu.vercel.app and easytutor-ten.vercel.app reachable
- Android SDK / EAS: NOT present (mobile APK build UNVERIFIABLE)
- GEMINI_API_KEY / APPWRITE_* / Supabase service keys: NOT set (live tests gated)
- Repo clones: /tmp/opencode/merge-job/stashmind, /tmp/opencode/merge-job/easytutor
- Branches: merge/stashmind-integration in BOTH repos (pushed to origin)
- PRs: #1 open in StashMind, #1 open in EasyTutor (NOT merged)

## Repo state

### StashMind (github.com/dmuhoro/stashmind)
- HEAD: d08e19e feat(architecture-M1-adrs): add eight merge architecture decision records
- Branch: merge/stashmind-integration (pushed, tracking origin)
- Tags: v0.9.0, v1.0.0, v1.0.0-rc1 → v1.0.0-rc1 EXISTS
- npm ci: PASS; npm run verify: PASS (typecheck 0, lint pass, 43 tests pass, build pass)
- doctor: 69 PASS, 12 WARN, 10 FAIL (S0-1 Google key in git history; S0-2 Vercel unfit for long jobs; S1 x9)
- Tests: 43 confirmed
- test:live: NOT RUN (credentials unset) → DONE-PENDING-GATE
- Playwright e2e: MISSING
- C-layers missing as individual commits: C10, C11, C13, C14, C15, C16 → DONE-PENDING-GATE / MISSING

### EasyTutor (github.com/dmuhoro/easytutor)
- HEAD: 77d717a feat(architecture-M1-adrs): add eight merge architecture decision records
- Branch: merge/stashmind-integration (pushed, tracking origin)
- Tags: v1-learning-intelligence, v1.0.1 → v1.0.1 EXISTS
- npm ci: PASS; typecheck 0 errors; lint 0 errors (127 warnings); tests 181 pass
- Deployed: home 200, HSTS present
- Mobile APK build: UNVERIFIABLE (no Android SDK/EAS)
- Offline test: exists but mocks fetch → STUB-OR-FAKE vs real Ollama

## Work completed (committed + pushed, PRs open, not merged)

### StashMind — 2 commits on merge/stashmind-integration
1. 7e0b612 fix(stabilization-readme): set test count to 43, remove supabase topic [S1-11, S1-12]
2. d08e19e feat(architecture-M1-adrs): add eight merge architecture decision records [M1]

### EasyTutor — 2 commits on merge/stashmind-integration
1. f9d4945 fix(stabilization-readme): align SDK and RN versions with package.json [S1-13]
2. 77d717a feat(architecture-M1-adrs): add eight merge architecture decision records [M1]

## Rule compliance
- Zero merges to main: branches only; PRs open, not merged
- Zero force-pushes / rewritten history: fast-forward pushes only
- Flags default OFF: no merge features enabled (ADR-M7)
- Zero weakened/skipped/deleted checks: test counts 43 / 181 unchanged; no gate relaxed
- Docs match code: README test-count and topic drift fixed (StashMind); README SDK/RN drift fixed (EasyTutor)

## Blocked (human gates / credentials required)

| Gate | Reason | Blocker |
|------|--------|---------|
| H2 | registry token or tagged-git install approval for @stashmind/core | Needed for M2 publish |
| H3 | staging service-account key + EasyTutor staging settings | Needed for M4 live staging test |
| H4 | real-phone + listening tests | Needed for C16 / C06 / EasyTutor offline |
| H6 | privacy sign-off on cross-system data flows | Needed for M8/M9 |
| S0-1 | Google API key prefix in StashMind git history | Credential owner must rotate |
| S0-2 | Vercel serverless unfit for ingest/TTS/ffmpeg lesson jobs | Propose container host |
| test:live / Playwright / live lesson timing | need credentials + real session + PDF | DONE-PENDING-GATE |

## M0 report, scorecard, re-audit
- M0-REPORT.md: claim/evidence/status table for both repos
- SCORECARD.md: layers planned vs complete, gate pass rate, evidence completeness, human interventions, test counts
- RE-AUDIT.md: zero false VERIFIED statuses confirmed

## Next action
Resume M2 (core hardening) only after H2 (registry/tagged-git approval). M4+ require H3/H4/H6. Until then, the run is paused at M1 with clean, pushed branches and open PRs. No self-certification: independent re-audit required before "Software Factory passed."
