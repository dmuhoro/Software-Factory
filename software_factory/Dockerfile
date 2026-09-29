# syntax=docker/dockerfile:1
#
# The Software Factory runtime. This is the artifact `k8s/deployment.yaml` runs and the
# artifact `software_factory/.github/workflows/ci.yml` builds, so this file is the production
# boundary. It had never been built. Building it produced four failures, in order.
#
#   1. The toolchain could not parse the committed lockfile. `rust:1.78-alpine` shipped Cargo
#      1.78, and the committed `Cargo.lock` pins `rand_pcg 0.10.2`, whose manifest requires
#      `edition2024` -- a feature not stabilized until Cargo 1.85. The build died during
#      dependency download. The image therefore could not be built at all, while CI reported
#      the job as the thing that keeps the image honest.
#
#   2. `Cargo.lock` was never copied into the build. Only `Cargo.toml` was, so cargo resolved
#      the dependency graph fresh on every build, with no `--locked`. The image would have
#      compiled a different dependency set than the one `cargo test` and `cargo clippy` ran
#      against on every other machine. This is the same defect as NC-3 in the TypeScript
#      tree, where the image installed a `bun.lock` that CI never tested: a green pipeline
#      about a build nobody deployed.
#
#   3. The dependency-cache step ended in `|| true`. A stub `main.rs` was built to warm the
#      cache, and if that build failed for any reason the failure was discarded, so the step
#      reported success having achieved nothing. A cache step that cannot fail is not a cache
#      step, it is a line that hides the next error.
#
#   4. `--target x86_64-unknown-linux-musl` was hardcoded, so the image could not be built on
#      arm64 at all -- including on Apple Silicon and on Graviton nodes, which is a real
#      deployment target rather than a hypothetical one.
#
# The fix is a same-distro glibc build with no musl target, `--locked` on every cargo
# invocation, an explicit copy of the sources the build needs, and no `|| true`. Dropping
# musl also removes the `openssl-libs-static` and `musl-dev` dependency dance, which existed
# only to satisfy a cross-target link that the runtime never needed.

# Pinned to a current stable toolchain. The floor that matters is Cargo 1.85, without which
# the committed lockfile cannot be parsed; anything below that fails at dependency download
# with a message that does not name the cause. `--locked` on every cargo call means a stale
# base image now fails loudly here instead of silently resolving different versions.
FROM rust:1-slim-bookworm AS builder

WORKDIR /app

# The manifest pair first, so dependency resolution is cached independently of the sources.
# Cargo.lock is what makes this build reproducible; without it this is a build of whatever
# the registry serves today.
COPY Cargo.toml Cargo.lock ./

# Warm the dependency cache against a stub, then prove it worked. The original had no
# `|| true` equivalent that could pass, which is the point: if the stub does not compile,
# the toolchain cannot build this project and the build must stop here.
RUN mkdir -p src \
  && echo 'fn main() {}' > src/main.rs \
  && cargo build --release --locked \
  && rm -rf src

# Explicit sources, not `COPY . .`. An unrestricted copy also brought in the 2.6GB `target/`
# directory, which is why this context needed 2.6GB to describe a few hundred KB of source.
# `.dockerignore` also excludes it, but the copy is narrow for its own sake: the build needs
# `src/`, and nothing else that happens to be in the directory.
COPY src ./src

# The stub build left artifacts for a binary this project does not have. Touching the entry
# point recompiles the crate itself while leaving every dependency artifact cached.
RUN touch src/main.rs && cargo build --release --locked

# Fail here, at the end of the build, if the binary is not the one the manifest declares.
# No `|| true`: this is the last line that can catch a build that produced no artifact, and
# the one that used to swallow exactly that failure.
RUN test -x target/release/software_factory

FROM debian:bookworm-slim AS runtime

# ca-certificates is the only runtime dependency, and it is load-bearing: without it every
# TLS call to Appwrite and Gemini fails certificate verification, which in a fail-closed
# service surfaces as a total outage rather than as a warning.
# curl is used by the HEALTHCHECK below only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# uid/gid 10001, matching the `runAsUser` and `runAsGroup` in k8s/deployment.yaml and the
# `USER` asserted by scripts/verify-image.sh. A mismatch between the image user and the
# pod's securityContext is the kind of inconsistency that only shows up at rollout.
RUN groupadd --system --gid 10001 factory \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin factory

WORKDIR /app
COPY --from=builder /app/target/release/software_factory /app/software_factory

# No shell-readable configuration, no credentials, no ledger. The service reads its
# configuration from the environment and refuses to start without it, so there is nothing
# here to leak; scripts/verify-image.sh checks that against the built image rather than
# trusting this comment.
USER 10001:10001

EXPOSE 8080

# start-period matters here. A cold Rust binary under a read-only root filesystem can take
# longer than the first check interval to bind, and a liveness probe without a start-period
# restarts a pod that was merely still starting. The pod-level startupProbe in the
# deployment already covers this properly; this is the same contract for a runtime that is
# started by something other than Kubernetes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/health" || exit 1

ENTRYPOINT ["/app/software_factory"]
