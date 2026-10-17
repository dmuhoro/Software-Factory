#!/usr/bin/env bash
#
# NC-4: prove the image's security and runtime properties against the built artifact.
#
# There is one image in this repository: `./Dockerfile`, the Node server, which is what
# `deploy/k8s/deployment.yaml` runs and what `.github/workflows/publish.yml` publishes.
#
# Until Sprint 34 there were two. The second was `software_factory/Dockerfile`, a Rust runtime
# that the manifest ran and this script verified first, because it was the artifact tenant
# traffic would have reached. The crate was deleted (WP-3, Option C): no user reached it, and it
# duplicated the tenant model. The image gate now verifies the one image that ships.
#
# The image had never been built. Building it found two defects, neither of which could be found
# by reading a Dockerfile:
#
#   1. npm: not found -- the oven/bun base had no npm, while invoking npm.
#   2. vite/esbuild shipped in the runtime image because build tools were declared as
#      production dependencies.
#
# (The deleted Rust image had five more -- an unparseable Cargo.lock, a lockfile never copied in,
# a `|| true` on the dependency cache, a hardcoded target triple, and no .dockerignore. Those
# checks went with the image; this script no longer asserts anything about a crate that is gone.)
#
# So this script does not read the Dockerfile. It builds the image, inspects what actually
# landed, walks the layer history for credentials, and starts the container. A claim about a
# container that has never been run is a claim about a document.
#
# Usage: scripts/verify-image.sh [node]

set -uo pipefail

TARGET="${1:-node}"
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
  local IMAGE_USER IMAGE_ENTRY RUN_UID
  IMAGE_USER="$(docker image inspect -f '{{.Config.User}}' "$IMAGE" 2>/dev/null || echo '')"
  IMAGE_ENTRY="$(docker image inspect -f '{{json .Config.Entrypoint}}' "$IMAGE" 2>/dev/null || echo '')"

  # There are two honest ways for a container to end up unprivileged, and this repository uses
  # both. A rootless `USER` is one. The Node image uses the other -- an entrypoint that drops
  # privileges with setpriv before exec -- deliberately, because a volume-capable platform mounts
  # its volume root:root and an unprivileged user cannot chown it. The first version of this
  # check looked only for `USER`, and so failed the Node image while the service was in fact
  # running as uid 10001 the whole time: a gate that measured the mechanism, not the outcome.
  # The question is which uid the service ends up as, so that is what is asserted.
  if printf '%s' "$IMAGE_ENTRY" | grep -q 'docker-entrypoint'; then
    RUN_UID="$(docker run --rm "$IMAGE" sh -c 'id -u' 2>/dev/null | tr -d '\r\n ')"
    if [ "$RUN_UID" = "$EXPECT_UID" ]; then
      pass "$NAME has no rootless USER; its entrypoint drops to uid $RUN_UID before exec"
    else
      fail "$NAME reports uid ${RUN_UID:-unknown} through its entrypoint; expected $EXPECT_UID"
    fi
    return
  fi

  if [ -z "$IMAGE_USER" ] || [ "$IMAGE_USER" = "root" ] || [ "$IMAGE_USER" = "0" ] || [ "$IMAGE_USER" = "0:0" ]; then
    fail "$NAME runs as ${IMAGE_USER:-root} with no privilege-dropping entrypoint; a container escape should not start from uid 0"
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


# ── The image the deployment runs (the Node server) ─────────────────────────────────────
section "Build the Node server image (./Dockerfile)"
if docker build -t sf-node-verify . >/tmp/sf-image-node.log 2>&1; then
  pass "the Node server image builds (it had never been built)"
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
# The final environment is not the layer history.
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
  # PID 1 is the node server, and it is the process the entrypoint setpriv'd to `factory` before
  # exec -- so PID 1's real uid is the honest answer. `docker exec id -u` runs a *new* process as
  # the image's configured user (root here, since the image carries no USER by design) and would
  # report root while the server runs unprivileged: the same wrong-instrument failure as above.
  IN_CTR="$(docker exec "$CONTAINER" sh -c 'grep -E "^Uid:" /proc/1/status | awk "{print \$2}"' 2>/dev/null | tr -d '\r\n ')"
  if [ "$IN_CTR" = "10001" ]; then
    pass "the serving Node container's PID 1 runs as uid $IN_CTR"
  else
    fail "the serving Node container's PID 1 reports uid ${IN_CTR:-unknown}; expected 10001"
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

section "The Node server: the sandbox runtime is present and can create a container"
# The loop shells out to bubblewrap for every sandboxed verification command (ADR-014 §5:
# absence is a refusal). An image without bwrap builds, boots, serves /health, and then dies
# at the sandbox boundary on the first real run -- and nothing above here would notice. So
# this section reports the runtime flags the sandbox needs AND proves the binary can actually
# create a container as the unprivileged user the server runs as. A binary that is present but
# cannot sandbox is the same failure wearing a different hat, and it fails closed here too.
SANDBOX_FLAGS=(--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined)
printf '  runtime flags the sandbox needs: %s\n' "${SANDBOX_FLAGS[*]}"
if docker run --rm --entrypoint sh sf-node-verify -c 'command -v bwrap >/dev/null 2>&1'; then
  pass "bubblewrap is installed in the Node image"
else
  fail "bubblewrap is absent from the Node image; every sandboxed run would refuse at the boundary"
fi
BWRAP_VERSION="$(docker run --rm --entrypoint sh sf-node-verify -c 'bwrap --version 2>/dev/null' | tr -d '\r\n')"
if [ -n "$BWRAP_VERSION" ]; then
  pass "the Node image reports $BWRAP_VERSION"
else
  fail "bubblewrap is present but reports no version; the binary is unusable"
fi
# The negative control is the whole point: run the container with the flags above and ask it
# to build a sandbox as uid 10001 -- the user the loop's sandboxed commands run as. A missing
# capability or a blocked namespace shows up here, not mid-run.
if docker run --rm "${SANDBOX_FLAGS[@]}" --user 10001:10001 --entrypoint sh sf-node-verify \
     -c 'bwrap --unshare-all --die-with-parent --ro-bind / / -- /bin/true' >/tmp/sf-node-bwrap.log 2>&1; then
  pass "bwrap creates a container at runtime as uid 10001 with: ${SANDBOX_FLAGS[*]}"
else
  fail "bwrap is installed but cannot create a container at runtime; the sandbox would refuse. Needed: ${SANDBOX_FLAGS[*]}"
  sed 's/^/    /' /tmp/sf-node-bwrap.log | tail -5
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ IMAGE GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
else
  printf '\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
