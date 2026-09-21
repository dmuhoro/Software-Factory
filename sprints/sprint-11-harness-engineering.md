# Sprint 11: Product-Manufacturing Harness

## Objective

Transform Software Factory from a controlled delivery loop into a durable product-manufacturing harness. The harness must govern what automation may do, mediate how it acts, and preserve runtime state, evidence, failures, approvals, and reusable institutional knowledge.

## The 32.4% capability gap

The imported repository-context baseline of 67.6/100 measures reusable institutional DNA, not product completeness. The remaining 32.4 points are the surrounding execution substrate: verification sensors, bounded repair, irreversible-action approvals, refreshable context, and hardened runtime/deployment adapters.

This sprint closes the first four capability groups and records the remaining boundary honestly. Repository completion improves the factory only after verified patterns and evidence are refreshed and deliberately promoted; no source code or credentials are silently copied.

## Completed

- Added repository-specific verification profile detection for Node/npm, Android Gradle, Rust Cargo, Python, and Git integrity repositories.
- Added sequential profile execution with bounded timeouts, exact command output, failed-step capture, and deterministic failure classification.
- Added a bounded repair loop that accepts explicit file patches, records every attempt, stops after a maximum of five attempts, and returns a durable passed, blocked, or no-repair outcome.
- Added a durable approval policy for production deployment, branch pushing, credential changes, data deletion, and external messages. Delivery now requires an approved production-deployment request.
- Added workspace-bound repository context refresh that records the current source commit and detects basic test/CI evidence.
- Added explicit institutional-pattern promotion so verified repository strengths can become named factory adapters.
- Added tenant-scoped approval APIs, repair-loop API, context refresh API, and pattern-promotion API.
- Added integration tests for all new harness capabilities.

## Verification evidence

`npm run verify` passes with 11 tests, TypeScript lint, frontend/server production build, and whitespace checks. The harness API smoke test returns HTTP 200 for health, repository contexts, context search, and tenant-scoped approvals.

## Capability after this sprint

A founder can run a repository-specific verification contract, inspect a classified failure, apply a bounded explicit repair, require approval before delivery, refresh repository evidence, and promote a reviewed pattern into future implementation plans. Every operation is durable, tenant-scoped, and auditable.

## Explicit remaining boundary

The harness is not yet a hardened untrusted-code execution platform. Container or microVM isolation, production deployment adapters, credential brokers, rollback automation, and semantic retrieval remain separate controlled phases. The current workspace boundary, timeout, explicit-file modifier, and approval policy prevent accidental authority expansion while those adapters are built.
