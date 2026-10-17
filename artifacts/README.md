# Deployable artifact

## What this is

The product image is the Node server, built from the root `Dockerfile` and published by
`.github/workflows/publish.yml` to `ghcr.io/dmuhoro/software-factory/node:<version>`, the same
tag `deploy/k8s/deployment.yaml` runs.

A local archive can be produced with `npm run verify:image` (it builds and exercises the image).
Archives are not committed: `.gitignore` excludes `artifacts/*.tar`, and a recorded digest in a
local file is not evidence anyone else can reproduce.

## Obsolete artifact, kept out of tree

Before Sprint 34 (WP-3, ADR-016) a second image was built from the Rust crate
(`software_factory/Dockerfile`, `gcr.io/b2b-software-factory/runtime`). That crate and its image
were deleted; the local `software-factory-runtime-4.8.0.tar` is that dead artifact and is not
tracked. Do not load or deploy it.

## The registry gap, stated plainly

No image has been pushed to a registry, because the push is gated on credentials this repository
does not have. Applying `deploy/k8s/deployment.yaml` to a cluster without first publishing
`ghcr.io/dmuhoro/software-factory/node:<version>` ends in `ImagePullBackOff`.
