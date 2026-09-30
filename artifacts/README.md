# Deployable artifact

## What this is

A loadable image archive for the production runtime, built from `software_factory/Dockerfile`
and version-matched to the tag in `software_factory/k8s/deployment.yaml`.

    software-factory-runtime-4.8.0.tar
    sha256  ebaa7c5ff179ff1a68730029d2ffdcecfa651ebda04f5394b22f69db3add03fb
    146MB image, 36MB archive, linux/amd64

## Verify before trusting

    sha256sum -c software-factory-runtime-4.8.0.tar.sha256
    docker load -i software-factory-runtime-4.8.0.tar
    docker run --rm software-factory-runtime:4.8.0 --version

The archive is intentionally not committed. It is reproducible from source in one command, and
committing a 36MB binary to history buys nothing that the recorded digest does not.

## The registry gap, stated plainly

`software_factory/k8s/deployment.yaml` references:

    gcr.io/b2b-software-factory/runtime:v4.8.0

**That image is not published.** The CI job that pushes to GCR is gated on `secrets.GCR_PUSH`,
which is not set, so no push has happened and none can happen without credentials. Applying that
manifest to a cluster today ends in `ImagePullBackOff`.

This is recorded here rather than quietly fixed, because "the manifest names an image" and "the
image exists" are different claims and only one of them is currently true.

Two ways to close it, neither costing money:

1. **Load it directly** (works now, single machine or `kind`/`k3d`):

       docker load -i software-factory-runtime-4.8.0.tar
       docker tag software-factory-runtime:4.8.0 gcr.io/b2b-software-factory/runtime:v4.8.0

   The tag already matches the manifest, so no manifest edit is needed.

2. **Publish to GHCR** (free, and the better long-term answer). Change the manifest reference to
   `ghcr.io/dmuhoro/software-factory-runtime:v4.8.0` and push with the workflow `GITHUB_TOKEN`,
   which already has `packages: write`. No new secret, no billing account.
