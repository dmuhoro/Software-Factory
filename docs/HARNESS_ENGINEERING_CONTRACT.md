# Harness Engineering Contract

## What the 67.6 baseline means

The imported-context baseline of **67.6/100** measures the quality of the reusable institutional DNA currently indexed from the five connected repositories. It is not a percentage of code that is missing from Software Factory, and it is not a promise that the connected products are 67.6% complete.

The remaining **32.4 points** represent the surrounding manufacturing system required to turn good repository patterns into repeatable, safe production execution:

| Capability gap | Target contribution | Status in this phase |
|---|---:|---|
| Repository-specific verification sensors | 8 | Implemented: Node, Android Gradle, Rust Cargo, Python, and Git profiles |
| Bounded failure classification and repair loop | 8 | Implemented: classified failures, explicit patches, maximum five attempts, durable outcomes |
| Approval policy for irreversible actions | 6 | Implemented: durable approval requests and delivery gate |
| Context refresh and institutional-pattern promotion | 5 | Implemented: workspace-bound refresh and explicit pattern promotion |
| Runtime isolation, deployment adapters, and production recovery | 5.4 | Partially implemented: ephemeral sanitized execution, filesystem release, health checks, rollback, recovery records, and backups exist; hardened container/microVM execution and hosted deployment remain separate adapters |

The gap is therefore covered by **capabilities**, not by simply finishing the five repositories. Completing a repository improves the factory only when its verified patterns, tests, evidence, and operational knowledge are deliberately refreshed and promoted into the context index.

## Does repository completion improve the factory automatically?

**Not automatically by default, and that is intentional.** A repository is a source of truth for its own product. Software Factory should not silently copy code, credentials, assumptions, or unverified claims from it.

The safe improvement path is:

```text
Repository change
  → refresh source commit and evidence
  → run repository verification profile
  → review new pattern or failure
  → explicitly promote institutional pattern
  → attach it to future plans
  → measure the next launch
```

The refresh endpoint updates the indexed repository commit and detects basic evidence signals within the approved workspace. The promotion endpoint requires an explicit repository, pattern, and factory adapter. This makes improvement deliberate and auditable while remaining fast.

Repository completion now has a direct operational path into the factory. A registered project can refresh its source commit, run its detected verification profile in an ephemeral sanitized snapshot, deploy a verified filesystem release after approval, record post-launch outcomes, and promote reviewed patterns. The factory still does not silently learn from unverified source changes.

## Harness layers

### Control layer

Constitution, ADRs, product briefs, implementation plans, quality gates, repository boundaries, approval policies, and evidence contracts define what may happen.

### Agency layer

The factory exposes mediated repository preparation, explicit file modification, verification profiles, previews, context refresh, approval operations, canonical project registration, daily inbox, continuation reports, isolated execution manifests, and filesystem release operations. The agency is intentionally narrower than arbitrary shell access.

### Runtime layer

Durable jobs now record verification profiles, failed steps, failure classes, repair attempts, approval requests, context refreshes, quality snapshots, completion tasks, release health, rollback targets, and audit events. The runtime also records failure owners, escalation thresholds, product outcomes, and graduated autonomy sessions with action, step, retry, and cost budgets. A repair loop is bounded to five attempts and accepts explicit file patches rather than unbounded agent authority.

## Verification profiles

The factory detects a repository profile from its files and manifests:

- **Node/npm**: `npm run verify` when present, otherwise declared lint/test/build scripts.
- **Android Gradle**: unit tests, lint, and offline release assembly.
- **Rust Cargo**: formatting, tests, and release build.
- **Python**: Ruff and pytest.
- **Git integrity**: diff check fallback.

A profile executes sequentially, stops at the first failure, records the exact command and output, and classifies the failure as typecheck, test, build, security, format, or unknown.

## Approval policy

Read, branch modification, verification, and preview are reversible factory operations. Pushing a branch, deploying production, changing credentials, deleting data, and sending external messages require explicit approval. A factory job cannot transition to `DELIVERED` until a durable `DEPLOY_PRODUCTION` approval exists, all required completion tasks are complete, and verification, test, or preview evidence is attached. A verified preview can be promoted through the filesystem release adapter, which records an artifact checksum, source commit, health check, current pointer, and rollback target.

## Honest boundaries

The completed phases make the factory suitable for a controlled founder daily pilot on registered low-risk projects. They do not yet justify the claim that the system can autonomously build any arbitrary product to hosted production with minimal supervision. A local Node process is not equivalent to a container or microVM, and the filesystem release adapter is not a hosted production deployment target. Production credentials, external messaging, hardened untrusted-code execution, hosted deployment, post-deployment observation, and rollback across real infrastructure require separate adapters with their own policy and evidence.
