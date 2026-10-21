# Launch Readiness & Real-World Usability — Three Products

Run: audit-three-product
Date: 2026-10-21

---

## Software Factory — launch readiness

**Readiness statement (from README):** "suitable for a controlled daily pilot on registered, low-risk projects." Not yet an unrestricted autonomous production company.

### What is live (14 capabilities)
Unattended execution loop, interactive intake (grill session), durable failure classification, unrelated-writes guard, bounded learning digest, one model-egress door, tenant-scoped control plane, fail-closed readiness, capability manifest, declarative skills registry, vendored hash-pinned advisory skills, PR-config preflight, sandboxed execution in image.

### What is blocked (4 capabilities, with owners)
| Capability | Owner | What unblocks it |
|------------|-------|------------------|
| Measured effect of skills | harness: engineering | `npm run bench:skills` with a reachable model |
| Hosted frontier model | operator | model provider registration + credentials |
| Live GitHub pull request | operator | `github:tokenSecret` allowlisted secret ref |
| External cloud runtime | operator | hosted deployment target + isolated secret injection |

### Real-world usability gaps
- No dashboards, alerts, or on-call on `/metrics` (owner: operator)
- No external identity provider — tenant id + secret = full access (owner: operator)
- Plaintext tenant credentials in process memory, not zeroized (residual NC-7)
- Single replica / single-writer ledger; horizontal scale is open non-conformance NC-2

**Verdict:** Ready for a controlled pilot on registered, low-risk projects. Not ready for unrestricted autonomous production work. The roadmap to production (README) lists 6 concrete gates.

---

## StashMind — launch readiness

### What works
- Health endpoint 200, auth boundary (401 on /me and POST /lessons), HSTS
- 43 tests, typecheck 0, build green, Appwrite backend, PWA manifest
- Tags v0.9.0, v1.0.0, v1.0.0-rc1 all present

### What blocks launch
- **S0-1:** Google API key prefix in git history — rotate before any production use
- **S0-2:** Vercel serverless unfit for ingest/TTS/ffmpeg lesson jobs — long jobs will be cut off; only real test is live PDF lesson timing (blocked, needs real session)
- Doctor S1 findings: demo user, retired Gemini models, mocked webhooks/TTS/voice, hard-coded model IDs in 4 files
- test:live not runnable (no GEMINI_API_KEY / APPWRITE_*); Playwright e2e absent
- Audit matrix stale (doctor_fail 19 vs actual 10; test_count 26 vs actual 43)

### Real-world usability
- Mobile-first Vite + React UI, PWA, Swahili support, data-saver mode
- But: lesson jobs may fail on Vercel; audio assembly unproven; no real-phone/listening tests

**Verdict:** Not launch-ready. S0-1 (key rotation) and S0-2 (host suitability) must be fixed first. Live PDF lesson timing test is the gating evidence.

---

## EasyTutor — launch readiness

### What works
- Gates green: typecheck 0, lint 0 errors, 181 tests pass
- Live site 200 with HSTS
- Offline/Ollama path exists in code; portal mapping (high_school/university/knowledge_explorer)
- Tags v1.0.1, v1-learning-intelligence present
- Feedback tables (ai_feedback, user_feedback) with RLS exist in schema

### What blocks launch
- **Offline test mocks fetch** — not a real Ollama test; STATUS.md admits physical Ollama endpoint not proven
- Mobile APK build unverifiable (no Android SDK/EAS)
- Feedback tables have no dedicated test
- Online (Anthropic/Groq) reachability proven (Groq 401) but authentication blocked

### Real-world usability
- Expo SDK 57 + React Native 0.86.3, offline-first, local Ollama, pgvector RAG
- Portal-aware presets, data-saver, local-first persistence
- But: offline quality depends on local Ollama model; device TTS varies by platform; mobile build unproven

**Verdict:** Not launch-ready for mobile production. Offline mode unproven against real Ollama; APK build unproven; needs H4 (real-phone/listening tests).

---

## Cross-product launch readiness

| Criterion | Status |
|-----------|--------|
| No data-store merge | ✅ Design keeps stores separate (shared core + HTTP API) |
| No StashMind key on phone | ✅ Service account server-side only (ADR-M2) |
| No second learner login | ✅ On-behalf-of via workspace mapping |
| Offline continuity | ⚠ EasyTutor offline exists but unproven against real Ollama |
| Flags default OFF | ✅ Designed so; nothing enabled yet |
| Privacy sign-off (H6) | ⏸ Pending |
| Correlation IDs / deletion propagation | ⏸ Designed (ADR-M8), not built |

**Verdict:** The integration design is sound (no data migration, server-side secrets, flags off). But no merge-layer code (M2–M10) has been built. Launch cannot proceed until H2/H3/H4/H6 are granted and S0 fixed.

---
