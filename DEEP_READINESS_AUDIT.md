# Software Factory: Deep Readiness Audit

**Repository:** `dmuhoro/Software-Factory`  
**Audit basis:** repository contents at commit `944fea1` (`main`)  
**Audit date:** 2026-09-18  
**Author:** Manus AI

## Executive conclusion

This asset is **not ready to operate as a real-world, larger-scale software-production factory**. It is a strong visual and architectural prototype of a multi-tenant AI processing control plane. It demonstrates a coherent frontend, a TypeScript API shape, domain adapters, Gemini schema concepts, tenant guardrails, a Rust service scaffold, and deployment documentation. However, the core claims that would make it a dependable software factory are not yet delivered as an integrated runtime.

My readiness estimate is **35/100 for production use**, with the following interpretation:

| Area | Current assessment | Confidence |
|---|---:|---|
| UI and product demonstration | 70/100 | High |
| TypeScript buildability | 80/100 | High; verified locally after dependency installation |
| Runtime integration completeness | 25/100 | High |
| Persistence and data durability | 10/100 | High |
| Security and tenant isolation | 25/100 | High |
| Tests and verification | 20/100 | High |
| Production operations | 25/100 | Medium-high |
| Actual software-product factory capability | 15/100 | High |

The codebase can become a useful product, but it should be positioned honestly today as an **interactive architecture demonstrator and AI telemetry transformation prototype**. It is not yet an automated system that can repeatedly discover valuable product opportunities, generate production software, validate it with real users, ship it, and learn from outcomes.

## What is already valuable

The repository has a meaningful foundation. The frontend is substantial and communicates a clear operating model: ingestion, tenant context, niche adapters, structured AI output, health signals, schema inspection, audit reporting, and resilience controls. The TypeScript compiler check and production build both pass after installing the declared dependencies. The build produces a working Vite bundle and a bundled Express server.

The repository also contains a coherent conceptual architecture. The Rust service defines Axum routes, Tokio-based async processing, tenant models, niche adapters, and integration tests. The TypeScript side defines corresponding concepts for tenant management, Gemini transformation, Appwrite schemas, validation, circuit breaking, and reporting. This makes the codebase a useful starting point rather than an empty shell.

The documentation is unusually ambitious for the current code size. The Constitution, schema documents, sprint files, and changelog provide a vocabulary for future engineering work. That documentation can reduce design drift if it is converted into executable contracts and kept synchronized with the implementation.

## The central diagnosis: presentation is ahead of execution

The largest risk is not ordinary technical debt. It is **claim-to-runtime divergence**. Several features are represented in the dashboard, changelog, architecture documents, or comments as production capabilities, while the underlying implementation is a simulation, an in-memory store, a no-op client, or a static preview.

The clearest example is Appwrite. `src/services/appwriteService.ts` declares an in-memory simulation using `Map` and leaves the real document write as commented code. The service therefore loses data on process restart and does not provide cross-instance consistency. The Rust `AppwriteClient` also logs that persistence completed but discards the payload and returns success without an Appwrite request (`software_factory/src/services/appwrite_client.rs:14-29`). This makes the claimed multi-tenant durable ledger unavailable in the actual runtime.

The operational metrics have the same problem. `src/api/routes/factory.routes.ts:18-78` labels worker-pool health and time-series metrics as simulated and generates values with `Math.random()` and time functions. These values cannot be used for alerting, capacity planning, incident response, or customer-facing service-level objectives. A dashboard that reports fabricated health is more dangerous than a dashboard that reports no health because it can create false confidence.

The Rust Gemini client contains a deterministic local mock when the key is missing or equals `TEST_KEY` (`software_factory/src/services/gemini_client.rs:26-42`). That is acceptable in a tightly isolated test mode, but the service defaults to `TEST_KEY` when the environment variable is absent (`software_factory/src/main.rs:18-21`). A production deployment could therefore appear healthy while returning synthetic AI output unless startup validation prevents it.

The product-level claim is also materially ahead of the implementation. The repository describes automated SDLC assembly, knowledge grounding, GitHub-connected product generation, and continuous multi-niche development, but the checked-in runtime primarily ingests telemetry and transforms it into structured output. There is no complete, tested loop for product discovery, specification, code generation, repository creation, branch/PR management, environment provisioning, deployment, user validation, and feedback-driven iteration.

## Architecture and runtime findings

### 1. Two runtimes create an integration boundary that is not closed

The repository contains a TypeScript/Express runtime and a Rust/Axum runtime. Both expose overlapping concepts, but there is no demonstrated production routing strategy between them, no contract test connecting them, and no single source of truth for tenant state, persistence, idempotency, or metrics. This creates a high probability of behavior drift.

The TypeScript server hardcodes `PORT = 3000` in `server.ts:7-10`, while the Rust service reads `PORT` and defaults to `8080` in `software_factory/src/main.rs:34-36`. The Kubernetes deployment targets the Rust service on port 8080, but the top-level application build and local server target a separate Express process. The repository needs an explicit service topology before it can be deployed safely.

### 2. Persistence is not implemented in the principal path

The TypeScript service uses process-local maps for telemetry and transformations. The Rust client is a no-op. There is no migration runner, no Appwrite provisioning script, no durable idempotency store, no retry-safe write protocol, and no reconciliation process.

This is a release-blocking issue. Without durable persistence, the system cannot guarantee auditability, replay, recovery, billing/quota accounting, or tenant-consistent behavior across replicas.

### 3. The AI integration is only partially productionized

The TypeScript service does call the Google GenAI SDK when configured, which is a useful real integration. However, timeout enforcement, request cancellation, model availability validation, cost controls, prompt/version storage, output validation, and durable retry/idempotency behavior need to be demonstrated with tests. The Rust client manually builds a Gemini URL and sends the API key in the query string (`software_factory/src/services/gemini_client.rs:45-61`), rather than using a centralized credential and client policy layer.

The configuration names models such as `gemini-3.8-flash` and `gemini-3.1-pro-preview` (`src/configurations/gemini.config.ts:6-10`). These identifiers must be validated against the target provider environment during deployment, with a startup check and a supported-model policy. A product cannot silently depend on model names that may not exist or may change availability.

### 4. The “software factory” loop is missing

The repository does not yet implement the differentiated loop that would justify the product category. The missing execution chain is:

1. Capture a customer or market problem.
2. Rank the opportunity using evidence and a defined scoring model.
3. Produce a versioned product specification and acceptance tests.
4. Generate or modify a repository through controlled tools.
5. Run static analysis, unit tests, integration tests, security checks, and browser verification.
6. Deploy to an isolated environment.
7. Collect real usage and outcome signals.
8. Decide whether to iterate, scale, or retire the product.

Until this loop exists and is measured end to end, the product remains an orchestration dashboard rather than a factory.

## Security and multi-tenant diagnosis

The repository has positive security intent: tenant headers, niche matching, validation helpers, rate limiting, circuit breakers, and declared Appwrite permissions. Intent is not equivalent to an enforceable boundary.

The tenant middleware uses a client-provided `X-Tenant-Id` or body field and resolves a tenant profile from an in-memory registry (`src/api/middleware/tenantAuth.ts:12-34`; `src/services/tenantService.ts:10-11`). It does not authenticate an end user, verify that the caller belongs to the tenant, or verify that the caller is authorized for the requested operation. A tenant identifier is a routing hint, not an identity credential.

The rate limiter is a process-local map (`src/api/middleware/rateLimiter.ts:14-40`). It will reset on restart, diverge between replicas, and allow a distributed caller to bypass the intended quota by spreading requests across instances. The configured global limit also does not appear to enforce the tier-specific quotas defined in `src/services/nicheAdapterService.ts:57-75`.

The Rust service defaults to `TEST_KEY` rather than failing closed. The Kubernetes manifests refer to a secret, but there is no checked-in evidence of secret creation, rotation, least-privilege policy, or a deployment gate that rejects missing secrets. The top-level `.env.example` contains placeholder values for Appwrite identifiers and a standard API key label. No credential is exposed in the checked-in history found during this audit, but secret scanning and history protection should still be added to CI.

The system needs a threat model, authenticated identity model, tenant membership checks, operation-level authorization, durable rate limiting, request size limits, schema validation at every boundary, redaction rules, audit log integrity, and security tests that attempt cross-tenant reads and writes.

## Reliability, operations, and scale diagnosis

The repository contains Kubernetes YAML, an HPA, probes, resource limits, JSON tracing, and a graceful shutdown path. Those are useful deployment ingredients, but they do not yet prove operational readiness.

The Kubernetes deployment image is a hardcoded `gcr.io/b2b-software-factory/runtime:v3.2.0` (`software_factory/k8s/deployment.yaml:35-36`). No checked-in CI workflow builds, signs, scans, publishes, or deploys that image. The manifests also define a Prometheus scrape annotation for `/metrics`, while the Rust router shown in `software_factory/src/main.rs:39-47` does not expose a metrics route. The declared readiness and observability contract is therefore incomplete.

There are no verified TypeScript tests in the repository. The Rust repository includes three integration tests, but Cargo was not available in the audit environment, so they could not be independently executed. The tests also use `TEST_KEY` and assert in-memory latency under 500 ms, which validates a mock path rather than a production path with network calls, persistence, retries, and load.

The frontend production bundle is approximately 764 kB before gzip. Vite reports a chunk-size warning. This is not a launch blocker for an internal dashboard, but it should be addressed before broad use through code splitting, route-level loading, and removal of unnecessary client-side weight.

The server has no visible request correlation middleware, body-size policy, graceful HTTP server shutdown, access log policy, metrics exporter, trace propagation, dependency health checks, or structured error taxonomy shared across the two runtimes. These are required for diagnosing failures at larger scale.

## Product readiness and indispensable-product diagnosis

The product has a compelling internal narrative: a governed, multi-tenant, AI-assisted platform for converting domain events into useful software or operational outcomes. The current implementation does not yet prove customer value because it lacks a narrow, measurable job-to-be-done and a live outcome loop.

The first real-world product should not attempt to serve real estate, healthcare, logistics, and generic B2B simultaneously. That breadth increases compliance, integration, evaluation, and sales complexity while the core factory loop is still unproven. Choose one narrow customer with an expensive, frequent, measurable workflow. Deliver one complete outcome better than the existing process. Use that wedge to build reusable factory primitives.

The dashboard is visually rich, but indispensable products are not made indispensable by dashboards alone. The product must produce an outcome that a customer would miss if removed: for example, a trustworthy automated workflow that turns a specific class of inbound operational event into a validated decision, an action in an existing system, and a durable explanation or audit trail. The current code demonstrates transformation and visualization, but not a complete customer-facing action with verified economic value.

## Recommended completion plan

### Phase 0: Stop claim drift and define the first product (3–5 days)

Freeze the current feature surface. Mark every dashboard metric and changelog item as **live**, **simulated**, **planned**, or **test-only**. Choose one initial customer workflow and write its success metrics, input contract, output contract, failure policy, and human-approval boundary. Decide whether Rust is the production engine or a future optimization; do not operate two overlapping runtimes without a clear ownership boundary.

### Phase 1: Make one vertical slice real (2–3 weeks)

Implement durable Appwrite persistence in one runtime. Add authenticated tenant identity and membership authorization. Replace process-local rate limiting with a shared mechanism or Appwrite-backed quota design. Add idempotency keys, durable job status, retries with bounded backoff, and safe replay. Validate the actual Gemini model and enforce startup configuration checks. Replace simulated health data with real counters and traces. Add contract tests for ingestion, transformation, persistence, authorization, and recovery.

At the end of this phase, one carefully scoped workflow should work from authenticated request through AI processing to durable result, with a reproducible local deployment and a clear audit trail.

### Phase 2: Production pilot hardening (3–5 weeks)

Add CI that installs dependencies from lockfiles, runs TypeScript checks, builds both services, runs tests, scans dependencies and secrets, builds the container, and validates Kubernetes manifests. Add staging deployment, migration/provisioning automation, backups and restore tests, error budgets, alerting, load tests, and an incident runbook. Add browser-level tests for the main user workflow and security tests for cross-tenant access.

At the end of this phase, the system can support a small number of real pilot customers under active engineering supervision.

### Phase 3: Build the actual factory loop (6–10 weeks)

Implement versioned product briefs, opportunity scoring, prompt and schema registries, repository/tool permissions, isolated execution sandboxes, code-generation jobs, test-and-repair loops, pull-request workflows, preview environments, deployment approvals, and outcome telemetry. Introduce an evaluation harness that scores generated products on correctness, security, usability, cost, latency, and customer outcome. This is the phase that turns the asset from an AI processing platform into a software factory.

### Phase 4: Scale and specialize (8–16 weeks, overlapping)

Add queue-based workload isolation, worker autoscaling based on queue depth and latency, tenant-level budgets, model routing, caching where safe, data retention policies, regional and compliance controls, support tooling, usage metering, and a controlled extension system for new vertical adapters. Add independent security review and, if handling regulated data, formal compliance work appropriate to the selected vertical.

## Time and staffing estimate

These estimates assume one senior full-stack engineer supported by part-time product/design and DevOps/security help. They are estimates for engineering work, not a promise of market adoption or regulatory approval.

| Target | Work remaining | One senior engineer | Small team of 3–4 |
|---|---|---:|---:|
| Honest internal demo | Clarify labels, fix setup, document known simulations | 3–5 days | 2–3 days |
| Real single-workflow pilot | Durable persistence, auth, one end-to-end workflow, tests, staging | 4–8 weeks | 2–4 weeks |
| Production baseline for early customers | CI/CD, security, observability, recovery, load testing, support operations | 10–16 weeks | 6–10 weeks |
| Credible software factory MVP | Add repository automation, isolated execution, validation loop, deployment and outcome feedback | 4–7 months | 3–5 months |
| Larger-scale dependable platform | Multi-tenant operations, queueing, governance, model economics, compliance, extensibility | 8–14 months | 6–10 months |

A faster schedule is possible only by reducing scope to one vertical, one deployment mode, one runtime, one persistence model, and one measurable customer outcome. Attempting to finish all four declared niches and the full factory vision at once will increase time and reduce reliability.

## Release gates

Do not call the product production-ready until all of the following are true:

- A fresh environment can be provisioned from documented commands without manual hidden steps.
- Both declared runtimes compile and their tests run in CI.
- An authenticated user cannot read or mutate another tenant’s data, including through alternate identifiers or retries.
- Appwrite writes are real, durable, permissioned, idempotent, and covered by failure tests.
- Missing credentials and unsupported model identifiers fail startup or fail requests closed; they never silently return production-looking mock output.
- Health and performance metrics are measured from real requests and workers.
- The primary customer workflow is tested from input to external outcome.
- A failed deployment can be rolled back and a data backup can be restored.
- Load, latency, cost, and error budgets are measured under representative workloads.
- The product has at least one customer outcome metric that is materially better than the incumbent process.

## Final verdict

**Attack verdict:** the repository is ahead of its runtime truth and behind its product ambition. The codebase is worth continuing, but not by adding more dashboard features or more architecture documents. The next move should be to delete ambiguity: pick one outcome, make one vertical slice real, close the authentication and persistence gaps, and instrument reality.

If the team executes that sequence, a supervised pilot is realistic in **4–8 weeks**. A production baseline for early customers is realistic in **10–16 weeks**. A dependable, scalable software factory that can repeatedly create and ship valuable products is more realistically a **6–14 month** program, depending on scope, staffing, regulatory requirements, and the strength of the chosen customer wedge.

## References

[1]: https://github.com/dmuhoro/Software-Factory "Software Factory repository"
[2]: https://github.com/dmuhoro/Software-Factory/blob/main/src/services/appwriteService.ts "Appwrite service implementation"
[3]: https://github.com/dmuhoro/Software-Factory/blob/main/src/api/routes/factory.routes.ts "Factory health and metrics routes"
[4]: https://github.com/dmuhoro/Software-Factory/blob/main/software_factory/src/services/appwrite_client.rs "Rust Appwrite client implementation"
[5]: https://github.com/dmuhoro/Software-Factory/blob/main/software_factory/src/services/gemini_client.rs "Rust Gemini client implementation"
[6]: https://github.com/dmuhoro/Software-Factory/blob/main/software_factory/k8s/deployment.yaml "Kubernetes deployment manifest"
[7]: https://github.com/dmuhoro/Software-Factory/blob/main/docs/CONSTITUTION.md "Software Factory constitution"
