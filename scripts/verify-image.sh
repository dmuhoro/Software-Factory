#!/usr/bin/env bash
#
# NC-4: prove the image's security and runtime properties against the built artifact.
#
# There are two images in this repository, and the distinction between them is the whole
# point of this script.
#
#   software_factory/Dockerfile  -> the Rust runtime. This is what k8s/deployment.yaml runs
#                                   and what software_factory/.github/workflows/ci.yml
#                                   builds. It is the production artifact.
#   ./Dockerfile                 -> the Node server. It is not referenced by the Kubernetes
#                                   manifests; it runs the same HTTP surface for local and
#                                   container-based development.
#
# The first version of this script verified only the Node image. That would have been a gate
# that proved the wrong artifact was safe while the one that ships went unbuilt. Both are
# verified now, and the Rust runtime is verified first, because it is the one that carries
# tenant traffic.
#
# Neither image had ever been built. Building them found seven defects between them, none of
# which could be found by reading a Dockerfile:
#
#   Rust runtime
#     1. rust:1.78 could not parse the committed Cargo.lock (rand_pcg 0.10.2 needs
#        edition2024, i.e. Cargo 1.85+). The image could not be built at all.
#     2. Cargo.lock was never copied into the build, and --locked was never passed, so the
#        image resolved a dependency graph that no test had ever run against.
#     3. The dependency-cache step ended in `|| true`, so a failed warm-up reported success.
#     4. --target x86_64-unknown-linux-musl was hardcoded; the image could not build on arm64.
#     5. There was no .dockerignore, so a 2.6GB target/ directory was sent on every build.
#
#   Node server
#     6. npm: not found -- the oven/bun base had no npm, while invoking npm.
#     7. vite/esbuild shipped in the runtime image because build tools were declared as
#        production dependencies.
#
# So this script does not read the Dockerfiles. It builds the images, inspects what actually
# landed, walks the layer history for credentials, and starts containers. A claim about a
# container that has never been run is a claim about a document.
#
# Usage: scripts/verify-image.sh [rust|node|all]

set -uo pipefail

TARGET="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

command -v docker >/dev/null 2>&1 || { echo "docker is required to verify an image" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "the docker daemon is not reachable" >&2; exit 2; }

# Walks the layer history of an image looking for a credential.
#
# This exists because the final-environment check is not the same claim. An intermediate layer
# can hold a secret that a later layer deletes, and the final environment will look clean. The
# history check is what makes "no credential is baked into any layer" true rather than merely
# "no credential is set on the finished image".
#
# Two independent things are looked for, because they leak differently:
#   1. a layer instruction that mentions a credential by name and assigns it. This covers
#      `ENV GEMINI_API_KEY=...` and `ARG TENANT_API_KEYS`, and equally
#      `RUN echo "GEMINI_API_KEY=..." > /tmp/x` followed by a later `RUN rm /tmp/x` -- the
#      final environment is clean in that case, which is the whole reason to look here
#   2. the *live value* of a credential that is set in this shell, appearing in any layer,
#      which catches a value pasted in with no variable name at all
#
# (2) is the stronger of the two and is only available when the verifying shell actually holds
# the secret. It is skipped, loudly, when it cannot be run -- a check that silently does nothing
# is the failure mode this repository keeps paying for.
#
# $1 = human name, $2 = image tag, $3 = alternation of secret variable names
assert_history_clean() {
  local NAME="$1" IMAGE="$2" SECRET_PATTERN="$3"
  local HISTORY LEAK
  HISTORY="$(docker history --no-trunc "$IMAGE" 2>/dev/null || true)"

  if [ -z "$HISTORY" ]; then
    fail "$NAME: layer history is unreadable, so 'no credential in any layer' cannot be claimed"
    return
  fi

  LEAK="$(printf '%s' "$HISTORY" | grep -E "($SECRET_PATTERN)=" || true)"
  if [ -n "$LEAK" ]; then
    fail "$NAME: a layer instruction assigns a credential: $(printf '%s' "$LEAK" | head -1 | cut -c1-120)"
  else
    pass "$NAME: no layer instruction assigns a credential by name"
  fi

  # The literal-value scan. Also catches a value pasted into a RUN or COPY without an ENV.
  local SCANNED=0
  local VAR VALUE
  for VAR in GEMINI_API_KEY APPWRITE_API_KEY APPWRITE_PROJECT_ID TENANT_API_KEYS FACTORY_API_KEY; do
    VALUE="${!VAR:-}"
    [ -z "$VALUE" ] && continue
    if printf '%s' "$HISTORY" | grep -qF -- "$VALUE"; then
      fail "$NAME: the live value of $VAR appears in the layer history"
    else
      SCANNED=$((SCANNED + 1))
    fi
  done
  if [ "$SCANNED" -eq 0 ]; then
    pass "$NAME: literal-value scan skipped -- no credential is set in this shell to scan for"
  else
    pass "$NAME: no live credential value ($SCANNED checked) appears in the layer history"
  fi
}

# Shared assertions, applied to whichever image is under test.
# $1 = image tag, $2 = human name, $3 = "uid the image must run as"
common_checks() {  local IMAGE="$1" NAME="$2" EXPECT_UID="$3"

  section "$NAME: runs as uid $EXPECT_UID, not root"
  local IMAGE_USER RUN_UID
  IMAGE_USER="$(docker image inspect -f '{{.Config.User}}' "$IMAGE" 2>/dev/null || echo '')"
  if [ -z "$IMAGE_USER" ] || [ "$IMAGE_USER" = "root" ] || [ "$IMAGE_USER" = "0" ] || [ "$IMAGE_USER" = "0:0" ]; then
    fail "$NAME runs as ${IMAGE_USER:-root}; a container escape should not start from uid 0"
  else
    pass "$NAME image config sets USER to '$IMAGE_USER'"
  fi
  RUN_UID="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u' 2>/dev/null | tr -d '\r\n ')"
  if [ "$RUN_UID" = "$EXPECT_UID" ]; then
    pass "$NAME reports uid $RUN_UID at runtime"
  elif [ -n "$RUN_UID" ] && [ "$RUN_UID" != "0" ]; then
    fail "$NAME reports uid $RUN_UID; expected $EXPECT_UID. A mismatch with the pod securityContext is a rollout failure"
  else
    fail "$NAME reports uid ${RUN_UID:-unknown}; it is root at runtime"
  fi
}

section "Build the production Rust runtime image (software_factory/Dockerfile)"
if docker build -t sf-rust-verify software_factory >/tmp/sf-image-rust.log 2>&1; then
  pass "the Rust runtime image builds (it had never been built)"
  printf '  size: %s bytes\n' "$(docker image inspect -f '{{.Size}}' sf-rust-verify)"
else
  fail "the Rust runtime image does not build; see /tmp/sf-image-rust.log"
  tail -15 /tmp/sf-image-rust.log
  printf '\n\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

section "The Rust runtime: the build recipe is reproducible (static)"
# These four are NOT observable at runtime, and the negative controls proved it. An image
# built from a Dockerfile that omits Cargo.lock and --locked still boots, still runs as
# uid 10001, still serves /health, and passes every check above. The result is a *working*
# image compiled from an untested dependency graph -- the same defect as NC-3, where the
# image installed a bun.lock that no CI run had ever exercised.
#
# So these are asserted against the build recipe and labelled static, because that is the
# only place they can be seen. A static assertion is legitimate here precisely because it is
# not pretending to be a runtime observation. Without this section the gate was green and
# proved nothing about reproducibility, which is the state this comment was written in.
DOCKERFILE_RUST=software_factory/Dockerfile

# Everything below is matched against Docker *instructions*, with comment lines stripped.
# A Dockerfile that documents a defect in prose is a normal and good thing to do; a grep that
# cannot tell a comment from a command then reports the documentation as the defect, and the
# check is worse than no check because it looks like it is working.
INSTRUCTIONS="$(grep -vE '^[[:space:]]*#' "$DOCKERFILE_RUST")"

# `|| true` on a build step is how the original Dockerfile reported success having built
# nothing. It is the most valuable single line to make illegal in a build recipe.
if printf '%s' "$INSTRUCTIONS" | grep -qE '\|\|[[:space:]]*true'; then
  fail "a build step can fail silently via '|| true' (static)"
else
  pass "no build step swallows failure with '|| true' (static)"
fi

# A hardcoded target triple makes the image unbuildable on arm64, which includes Graviton.
if printf '%s' "$INSTRUCTIONS" | grep -qE -- '--target[[:space:]]+[a-z0-9_]+-(unknown|linux)-'; then
  fail "the build hardcodes a target triple and cannot build on arm64 (static)"
else
  pass "the build does not hardcode a target triple (static)"
fi

# The lockfile assertion gets the same treatment: a comment about Cargo.lock is not a copy.
if printf '%s' "$INSTRUCTIONS" | grep -qE '^[[:space:]]*COPY[[:space:]].*Cargo\.lock'; then
  pass "Cargo.lock is copied into the build (static)"
else
  fail "Cargo.lock is never copied into the build; the image resolves a fresh graph (static)"
fi

if printf '%s' "$INSTRUCTIONS" | grep -E 'cargo (build|install|update)' | grep -qv -- '--locked'; then
  fail "an unlocked cargo invocation would resolve versions freely (static)"
else
  pass "every cargo invocation uses --locked (static)"
fi

common_checks sf-rust-verify "the Rust runtime" "10001"

section "The Rust runtime: no credential is baked into any layer"
ENV_BAKED="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' sf-rust-verify 2>/dev/null \
  | grep -E '^(GEMINI_API_KEY|APPWRITE_API_KEY|TENANT_API_KEYS)=' || true)"
if [ -n "$ENV_BAKED" ]; then
  fail "the Rust image bakes a credential into its environment"
else
  pass "the Rust image environment contains no credential"
fi
# The check above reads the *final* environment. That is a weaker statement than "no layer",
# and the difference is exploitable: `RUN echo KEY=... > /tmp/x` followed by `RUN rm /tmp/x`
# leaves a credential in an intermediate layer while the final environment looks clean. So the
# layer history is walked separately, which is what this script claimed to do.
assert_history_clean "the Rust image" sf-rust-verify \
  "GEMINI_API_KEY|APPWRITE_API_KEY|APPWRITE_PROJECT_ID|TENANT_API_KEYS|FACTORY_API_KEY"

section "The Rust runtime: it refuses to start without configuration, and names what is missing"
# The fail-closed contract is enforced one variable at a time, so this walks them in order.
# The image must die at every step and must never serve a single request while unconfigured.
RUST_REQUIRED=(GEMINI_API_KEY APPWRITE_API_KEY APPWRITE_PROJECT_ID APPWRITE_ENDPOINT TENANT_API_KEYS)
declare -a RUST_ENV=()
RUST_REFUSED=0
RUST_NAMED=0
for VAR in "${RUST_REQUIRED[@]}"; do
  docker run --rm "${RUST_ENV[@]}" sf-rust-verify >/tmp/sf-rust-refuse.log 2>&1
  RC=$?
  if [ "$RC" -eq 0 ]; then
    fail "the Rust runtime started to completion while $VAR was unset"
  else
    RUST_REFUSED=$((RUST_REFUSED + 1))
    for CANDIDATE in "${RUST_REQUIRED[@]}"; do
      if grep -q "$CANDIDATE" /tmp/sf-rust-refuse.log 2>/dev/null; then
        RUST_NAMED=$((RUST_NAMED + 1))
        break
      fi
    done
  fi
  RUST_ENV+=(-e "$VAR=verify-gate-value")
done
if [ "$RUST_REFUSED" -eq "${#RUST_REQUIRED[@]}" ]; then
  pass "the Rust runtime refused to start for all ${#RUST_REQUIRED[@]} missing variables"
else
  fail "the Rust runtime only refused $RUST_REFUSED of ${#RUST_REQUIRED[@]} missing variables"
fi
if [ "$RUST_NAMED" -gt 0 ]; then
  pass "the refusal names a required variable ($RUST_NAMED of ${#RUST_REQUIRED[@]} refusals)"
else
  fail "the Rust refusal does not name any required variable ($RUST_NAMED of ${#RUST_REQUIRED[@]} did)"
fi

section "The Rust runtime: it serves, as a non-root user, when configured"
PORT=18778
CONTAINER="sf-rust-verify-run"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT:8080" \
  -e GEMINI_API_KEY=verify-gate-value \
  -e APPWRITE_API_KEY=verify-gate-value \
  -e APPWRITE_PROJECT_ID=verify-gate-value \
  -e APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1 \
  -e TENANT_API_KEYS=verify-tenant:verify-key \
  sf-rust-verify >/dev/null 2>&1

READY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -eq 1 ]; then
  pass "the Rust runtime serves /health"
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || echo '{}')"
  if printf '%s' "$HEALTH" | grep -q '"status":"alive"'; then
    pass "/health reports real liveness state: $HEALTH"
  else
    fail "/health returned no recognizable state: $HEALTH"
  fi
  if curl -fsS "http://127.0.0.1:$PORT/metrics" 2>/dev/null | grep -q 'sf_build_info'; then
    pass "/metrics serves Prometheus series"
  else
    fail "/metrics did not serve the build-info series"
  fi
  IN_CTR="$(docker exec "$CONTAINER" id -u 2>/dev/null | tr -d '\r\n ')"
  if [ "$IN_CTR" = "10001" ]; then
    pass "the serving Rust container is uid $IN_CTR"
  else
    fail "the serving Rust container reports uid ${IN_CTR:-unknown}; expected 10001"
  fi
  HSTATE="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo none)"
  case "$HSTATE" in
    starting|healthy) pass "the declared HEALTHCHECK reports '$HSTATE'" ;;
    none) fail "the Rust image declares no HEALTHCHECK" ;;
    *) fail "the declared HEALTHCHECK reports '$HSTATE' while the service is up" ;;
  esac
else
  fail "the Rust runtime never became ready; see docker logs $CONTAINER"
  docker logs --tail 15 "$CONTAINER" 2>&1 | sed 's/^/    /'
fi
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

if [ "$TARGET" = "rust" ]; then
  printf '\n'
  if [ "$FAIL" -eq 0 ]; then
    printf '\033[32m════ IMAGE GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
  else
    printf '\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
    exit 1
  fi
  exit 0
fi

# ── Node development server image ────────────────────────────────────────────────────────
section "Build the Node server image (./Dockerfile)"
if docker build -t sf-node-verify . >/tmp/sf-image-node.log 2>&1; then
  pass "the Node server image builds (it had never been built either)"
  printf '  size: %s bytes\n' "$(docker image inspect -f '{{.Size}}' sf-node-verify)"
else
  fail "the Node server image does not build; see /tmp/sf-image-node.log"
  tail -15 /tmp/sf-image-node.log
  printf '\n\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

common_checks sf-node-verify "the Node server" "10001"

section "The Node server: no credential is baked into any layer"
for name in .env .env.local .data; do
  if docker run --rm --entrypoint sh sf-node-verify -c "test -e /app/$name" >/dev/null 2>&1; then
    fail "/app/$name is present in the Node image"
  else
    pass "/app/$name is absent from the Node image"
  fi
done
ENV_BAKED="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' sf-node-verify 2>/dev/null \
  | grep -E '^(APPWRITE_API_KEY|GEMINI_API_KEY|TENANT_API_KEYS|FACTORY_API_KEY)=' || true)"
if [ -n "$ENV_BAKED" ]; then
  fail "the Node image bakes a credential into its environment"
else
  pass "the Node image environment contains no credential"
fi
# Same distinction as the Rust image above: the final environment is not the layer history.
assert_history_clean "the Node image" sf-node-verify \
  "APPWRITE_API_KEY|APPWRITE_PROJECT_ID|GEMINI_API_KEY|TENANT_API_KEYS|FACTORY_API_KEY"

section "The Node server: it refuses to start without configuration"
docker run --rm sf-node-verify >/tmp/sf-node-refuse.log 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
  pass "an unconfigured Node container exits $RC instead of serving"
else
  fail "an unconfigured Node container ran to completion"
fi
if grep -qiE 'refus|required|must be set' /tmp/sf-node-refuse.log 2>/dev/null; then
  pass "the refusal names a missing configuration variable"
else
  fail "the Node container exited but the log does not say what was missing"
fi

section "The Node server: it serves, as a non-root user, when configured"
PORT=18779
CONTAINER="sf-node-verify-run"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT:3000" \
  -e FACTORY_API_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  -e FACTORY_TENANT_SEED_DEMO=true \
  sf-node-verify >/dev/null 2>&1
READY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/factory/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -eq 1 ]; then
  pass "the Node container serves its health endpoint"
  IN_CTR="$(docker exec "$CONTAINER" id -u 2>/dev/null | tr -d '\r\n ')"
  if [ "$IN_CTR" = "10001" ]; then
    pass "the serving Node container is uid $IN_CTR"
  else
    fail "the serving Node container reports uid ${IN_CTR:-unknown}"
  fi
else
  fail "the Node container never became ready; see docker logs $CONTAINER"
  docker logs --tail 15 "$CONTAINER" 2>&1 | sed 's/^/    /'
fi
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

section "The Node server: no build tooling in the runtime image"
# These are compiled into dist/assets by `vite build`. Their presence means build tools were
# declared as production dependencies and `npm ci --omit=dev` correctly kept them, which is
# how this check first failed.
for tool in vite esbuild tsc; do
  if docker run --rm --entrypoint sh sf-node-verify -c "test -e /app/node_modules/$tool" >/dev/null 2>&1; then
    fail "the build tool '$tool' is present in the Node runtime image"
  else
    pass "the build tool '$tool' is absent from the Node runtime image"
  fi
done

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ IMAGE GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
else
  printf '\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
