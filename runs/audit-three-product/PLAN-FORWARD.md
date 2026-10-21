# Plan and Strategy Forward — StashMind × EasyTutor Merge (Tier 2)

Run: audit-three-product
Date: 2026-10-21

Current position: M0 verification + M1 architecture complete. M2+ blocked on human gates H2/H3/H4/H6 and S0 credential fixes. PRs merged to main (DoD #6 failed) at your request.

---

## Immediate actions (this week, no code build)

1. **Restore DoD compliance** — Decide whether the merged state is acceptable or whether to revert PR #1s to branches and re-open unmerged. If you want the merge job to satisfy its own Definition of Done, the PRs must be unmerged and the work kept on `merge/stashmind-integration` branches.
2. **Rotate the Google API key** (S0-1) — the key prefix is in StashMind git history. Credential owner rotates; do not force-push history (protocol forbids). New key goes to server-side env only.
3. **Decide the long-job host** (S0-2) — Vercel serverless cuts off ingest/TTS/ffmpeg. Propose a container host (Docker / long-lived Node service per the original plan) or accept Vercel limits and scope lessons accordingly.
4. **Grant H2/H3/H4/H6** — registry token, staging service-account key, real-phone/device access, privacy sign-off. These are operator decisions, not agent decisions.

---

## Build sequence (once gates are granted)

| Layer | Repo | Depends on | Est. effort |
|-------|------|------------|-------------|
| M2 Core hardening | StashMind | H2 (publish/tagged-git) | 1–2 days |
| M3 Client & on-behalf-of | StashMind | M2 | 2–3 days |
| M4 EasyTutor bridge | EasyTutor | M2, M3, H3 | 2–3 days |
| M5 EasyTutor UI | EasyTutor | M4 | 3–4 days |
| M6 Offline & degrade | EasyTutor | M4, H4 | 2–3 days |
| M7 Router convergence | Both | M2, M3 | 3–4 days |
| M8 Learning-data links | Both | M7 | 2–3 days (stretch) |
| M9 Cross-product hardening | Both | M8 | 3–4 days |
| M10 Release | Both | M9 | 1–2 days |

Total: ~16–26 days of build once unblocked, one commit per layer per repo, PRs open not merged, flags default OFF.

---

## Definition of Done (remaining)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Gates green, tests ≥43 / ≥181 | ✅ Green (but doctor S0/S1 unaddressed) |
| 2 | Flags OFF → no behaviour change | ✅ Nothing built yet |
| 3 | Flag ON → cross-product e2e on staging | ⏸ Blocked (H3) |
| 4 | No secrets in bundle/repos/logs | ❌ S0-1 key rotation pending |
| 5 | EasyTutor offline works (real Ollama) | ❌ Test mocks fetch — needs H4 |
| 6 | PRs open, not merged | ❌ Merged at your request |
| 7 | Independent re-audit: zero false VERIFIED | ✅ M0 claims confirmed |
| 8 | Scorecard complete | ✅ In runs/m0-20261021-102705/ |

---
