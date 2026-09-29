# Sprint 15 — Production Hardening (Layers 2–4)

**Status:** complete · **Release:** 4.7.0-production-hardening · **Date:** 2026-09-29

Follows `docs/CONSTITUTION.md` and ADR-001…004. Every claim below is backed by a command
that was run; where something could not be verified here, it is listed under *Not verified*
rather than described as done.

---

## Why this sprint exists

Layer 1 hardened the TypeScript service. This sprint found that the **Rust runtime had no
tenant enforcement at all**, and that several TypeScript and Rust guarantees existed only on
paper. The recurring theme: protections that were written, reviewed, and commented as if
active, but were never connected to the path real requests take.

---

## Defects closed

### Critical — tenant isolation

| Defect | What it actually did | Fix |
|---|---|---|
| `require_tenant_header` never applied | `main.rs` layered only `TraceLayer`, so `POST /api/v1/telemetry/ingest` accepted writes for any tenant from any unauthenticated caller | Guard layered onto the real router |
| Guard checked only header presence | Would have authenticated nothing even once wired | Key must be the one provisioned for the claimed tenant, compared in constant time |
| `GET /api/v1/tenants` | Returned every tenant to anyone | `GET /api/v1/tenants/me`, scoped by the guard-resolved tenant |
| `GEMINI_API_KEY` → `TEST_KEY` | Misconfigured deploy returned invented data asserting `complianceVerified: true` | Refused at startup; mock now opt-in via `GEMINI_MOCK=1` and self-identifies |

### Critical — durability

| Defect | What it actually did | Fix |
|---|---|---|
| Writer lock released per write | Held for one load, not for the process. A second writer opened the same ledger silently and would have overwritten records | Held for process lifetime, released explicitly on shutdown |
| Lock opened before the data directory | `ENOENT` on a first run on an empty volume | Directory ensured before locking |
| Unhealthy pre-flight only printed | Bound a port anyway | Refuses to serve, exits 75 |

### High — disclosure and honesty

| Defect | What it actually did | Fix |
|---|---|---|
| `error.message` published, all `409` | Absolute paths and internal ids to the client; a `TypeError` read as "retry" | One classifier; unknown faults → `500` + correlation id |
| Unescaped audit report | Client-posted `eventType` became executable markup in a file an auditor opens | All 11 interpolation sites escaped |
| Unknown `/api` path | `200` + HTML, so a typo looked like success | `404` JSON |
| `persist_transformation` no-op | Logged "persistence completed", returned `Ok(())`, wrote nothing | Performs the write; pipeline awaits it and refuses the event on failure |
| `/health` literals | `"circuit_breaker": "CLOSED"`, `"hpa_status": "READY"` as constants | Liveness reports only liveness; `/ready` reports real configuration |
| Readiness on `/health` | Unconfigured pod still received traffic | Readiness on `/ready` |
| cert-manager annotation, no `tls` block | Host served over plain HTTP | `tls` block binds the certificate |
| No deadline on retried AI work | 25s × 4 attempts held a request >90s | Required finite `deadlineMs`; `OPERATION_DEADLINE_EXCEEDED` with `cause` |

### Also fixed

- Gemini key moved from query string to header (query strings persist in proxy logs).
- Report build threw on a log with no `status`; now degrades.
- `unwrap()` on the TLS client build panicked a worker thread.
- Both harnesses leaked a server by recording the subshell pid.
- The Layer 2 throttle probe could never have passed (wrong design, wrong tenant tier).

---

## Files

### Added
```
package-lock.json                                 npm install reproducibility for CI
scripts/verify-layer2.sh                          26-check live tenant-isolation harness
scripts/verify-layer3.sh                          24-check live error-contract harness
software_factory/Cargo.lock                       pinned Rust dependency graph
software_factory/k8s/namespace.yaml               so the manifest set is appliable in order
software_factory/k8s/networkpolicy.yaml           default-deny ingress + egress
software_factory/k8s/secret.example.yaml          required keys, values to replace
software_factory/scripts/verify-k8s.py            51 manifest assertions
software_factory/tests/tenant_guard_tests.rs      10 tests on the real router
src/utils/apiError.ts                             one error classifier
src/utils/respondWithError.ts                     shared route responder
src/utils/tenantCredentials.ts                    salted-scrypt tenant credentials
test/l2-tenant-isolation.test.ts                  11 tests
test/l3-error-contract.test.ts                    14 tests
test/l3-report-generator.test.ts                  6 tests
test/l3-enrichment-deadline.test.ts               6 tests
```

### Modified
```
.env.example                                       FACTORY_TENANT_CREDENTIALS documented
package.json                                       verify:layer2, verify:layer3, version 4.7.0
scripts/verify-layer1.sh                           leak fixed
server.ts                                          fail-closed pre-flight, /api 404, lock release
src/api/index.ts                                   auth before rate limiting
src/api/middleware/errorHandler.ts                 classifier-backed
src/api/middleware/rateLimiter.ts                  principal-keyed quota
src/api/middleware/tenantAuth.ts                   credential-bound tenant auth
src/api/routes/*.routes.ts                         8 modules migrated off raw-message helpers
src/configurations/gemini.config.ts                overallDeadlineMs
src/configurations/runtimeConfig.ts                tenant credential config
src/services/durableStore.ts                       process-lifetime writer lock
src/services/geminiService.ts                      deadline passed
src/services/healthService.ts                      contention is fatal
src/services/tenantService.ts                      credential ownership
src/utils/circuitBreaker.ts                        wall-clock deadline
src/utils/reportGenerator.ts                       escaping + safe filename
software_factory/Cargo.toml                        version 4.7.0
software_factory/src/lib.rs                        tenant credential store
software_factory/src/main.rs                       guard wiring, fail-closed config
software_factory/src/middleware/tenant_guard.rs    authentication, constant-time compare
software_factory/src/routes/health.rs              honest liveness, real readiness
software_factory/src/routes/telemetry.rs           error classification, own-tenant read
software_factory/src/services/appwrite_client.rs   real write, no silent success
software_factory/src/services/gemini_client.rs     mock gated, key in header, no panic
software_factory/src/services/pipeline.rs          awaits the audit write
software_factory/src/adapters/*.rs                 rustfmt
software_factory/tests/integration_tests.rs        rewritten against a real Appwrite stub
software_factory/k8s/deployment.yaml               hardening, readiness, probes
software_factory/k8s/ingress.yaml                 TLS bound
```

### Also
```
.github/workflows/verify.yml                       CI gate (added in L5a)
CHANGELOG.md                                       4.7.0 entry with an "Open" section
```

---

## Verification run

| Check | Result |
|---|---|
| `npm test` | 76/76 |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `verify:layer1` | 34/34 |
| `verify:layer2` | 26/26 |
| `verify:layer3` | 24/24 |
| Servers left listening | none |
| `cargo test` | 15/15 |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `python3 scripts/verify-k8s.py` | 51/51 |

**Live checks against the compiled Rust binary** (the guard's wiring, not just its logic):

| Request | Result |
|---|---|
| Ingest, no headers | 401 |
| Ingest, tenant B's key claiming tenant A | 403 |
| Ingest, invented tenant | 403 |
| `/health` | 200 |
| `/api/v1/tenants/me` anonymous | 401 |
| `/api/v1/tenants/me` with own credential | 200, own tenant only |
| Startup without `GEMINI_API_KEY` | exit 1 |
| Startup without `TENANT_API_KEYS` | exit 1 |
| Startup with one key bound to two tenants | exit 1 |

**Fixes confirmed to be load-bearing**, by reverting each and watching the gate fail:

- `escapeHtml` → pass-through: 3 report tests fail.
- `deadlineMs` → infinity: 5 deadline tests fail.
- `/ready` → `/health`: manifest validator fails.

---

## Not verified / deliberately open

- **The TypeScript tenant registry is in-memory.** Tenants do not survive a restart and the
  service cannot scale horizontally. The one gap that most limits real multi-tenant use.
- **The Docker image has never been built.** Non-root and secret-free are verified by
  inspection only. `docker` was unavailable in this environment.
- **Both `bun.lock` and `package-lock.json` are tracked.** CI runs npm because that is what the
  harnesses were executed under. Unreconciled.
- **A credential configured for an unknown tenant id warns rather than fails startup.**
- **Plaintext `FACTORY_TENANT_CREDENTIALS` is retained in process memory** for the process
  lifetime.
- **NetworkPolicy egress permits 443 to `0.0.0.0/0`.** Needs a CIDR allowlist or gateway.
- **No metrics endpoint on the Rust runtime.** The Prometheus scrape annotation was removed
  rather than left pointing at a 404.
