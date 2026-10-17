# ADR-016: Delete the Rust Runtime; One Node Runtime

## Status

Accepted. Supersedes [ADR-003](ADR-003-rust-tokio-high-throughput-concurrency.md).

## Context

ADR-003 introduced a Rust/Tokio ingestion engine in `software_factory/`. It was never wired
into the product: the running service is the Node control plane, and the crate had no
deployment of its own. Over time it accumulated its own Dockerfile, k8s manifests, CI
workflows, a separate verification script, an image-publishing matrix entry, and a
`Cargo.lock` version record — all of which had to be kept in sync with a runtime that
nothing ran.

Sprint 33 WP-7 assessed the three options in `docs/RUST-RUNTIME-DECISION-MEMO.md`. The
operator chose Option C, delete the crate. Sprint 34 WP-3 executed it and tagged the last
commit containing the crate as `rust-runtime-final` so the history is recoverable.

Deleting the crate would also have deleted the only k8s manifests in the repository, and
with them the NetworkPolicy that NC-5 relies on. Those manifests describe the **product**
deployment, not the Rust image, so they were moved to `deploy/k8s/` and the deployment was
retargeted to the Node image. `verify-k8s.py` moved to `scripts/` and now parses the
manifests where they live.

## Decision

1. The product has exactly one runtime: the Node control plane. `software_factory/` is
   deleted; the last commit that contained it is tagged `rust-runtime-final`.
2. The product's Kubernetes manifests live in `deploy/k8s/` and run
   `ghcr.io/dmuhoro/software-factory/node:<version>`.
3. NC-4 (image is built, not inspected) and NC-9 (metrics report the ledger) are re-anchored
   to the Node artifact: `scripts/verify-image.sh` verifies the one image, and
   `scripts/verify-layer1.sh` scrapes the live `/metrics` after two ingests.
4. NC-8 keeps its Node-side proof (`test/l5-niche-refusal.test.ts`); the Rust
   `get_adapter` reference is removed with the crate.
5. A release is described in **four** sites: `package.json`, `package-lock.json`,
   `CHANGELOG.md`, and the image tag in `deploy/k8s/deployment.yaml`.

## Consequences

- Positive: one runtime, one image, one lockfile, one set of manifests. The version gate
  cannot disagree with itself, and no CI job can pass while the thing it checks is unbuilt.
- Negative: the sub-millisecond ingestion prototype is gone. If throughput ever justifies a
  second runtime, it returns as a new ADR with a wired, deployed, verified service — not as a
  crate that nothing runs.
- Recovery: `git checkout rust-runtime-final -- software_factory/` restores the crate.
