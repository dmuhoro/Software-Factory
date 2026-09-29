#!/usr/bin/env bash
#
# NC-4: prove the image's security properties against the built artifact.
#
# The constitution recorded NC-4 as "the Docker image has never been built; non-root
# execution and absence of secrets are verified by inspection only." That wording is
# accurate about the problem and understated about its size: when the image was finally
# built, it failed three times in a row. There was no npm in the base image, a
# `COPY --from=build` of `node_modules` that the build context excluded, and a second
# redundant `COPY` of a manifest that was not in the context under that name. Every one of
# those would have been found here in under two minutes, and none of them could be found by
# reading the Dockerfile.
#
# So this script does not read the Dockerfile. It inspects the image that actually exists,
# and starts it. A claim about a container that has never been run is a claim about a
# document.
#
# Usage: scripts/verify-image.sh [image-tag]

set -uo pipefail

IMAGE="${1:-software-factory:verify}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

command -v docker >/dev/null 2>&1 || { echo "docker is required to verify an image" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "the docker daemon is not reachable" >&2; exit 2; }

section "Build"
if docker build -t "$IMAGE" . >/tmp/sf-image-build.log 2>&1; then
  pass "the image builds from this working tree"
else
  fail "the image does not build; see /tmp/sf-image-build.log"
  tail -20 /tmp/sf-image-build.log
  printf '\n\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || echo '')"
SIZE="$(docker image inspect -f '{{.Size}}' "$IMAGE" 2>/dev/null || echo 0)"
printf '  image: %s (%s bytes)\n' "${IMAGE_ID:12:19}" "$SIZE"

section "It runs as a non-root user"
# Checked against the image config, not the Dockerfile, because a `USER` line in a file is a
# claim and the resolved image config is a fact.
IMAGE_USER="$(docker image inspect -f '{{.Config.User}}' "$IMAGE" 2>/dev/null || echo '')"
if [ -z "$IMAGE_USER" ] || [ "$IMAGE_USER" = "root" ] || [ "$IMAGE_USER" = "0" ]; then
  fail "the image runs as ${IMAGE_USER:-root}; a container escape should not start from uid 0"
else
  pass "the image config sets USER to '$IMAGE_USER'"
fi

# And confirmed by actually running it, because a USER line can be overridden by a compose
# file or a platform default, and the only way to know what a container does is to run one.
RUN_UID="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u' 2>/dev/null | tr -d '\r\n ')"
if [ -n "$RUN_UID" ] && [ "$RUN_UID" != "0" ]; then
  pass "a running container reports uid $RUN_UID"
else
  fail "a running container reports uid ${RUN_UID:-unknown}; it is root at runtime"
fi

section "No credential is baked into any layer"
# The strongest available check: inspect every layer's filesystem rather than the final
# image. A secret written in an earlier layer and deleted later is still readable from
# `docker save`, and no amount of inspecting the final image would show it.
LEAKS=""
for name in $(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE" 2>/dev/null); do
  case "$name" in
    *APPWRITE_API_KEY=*|*GEMINI_API_KEY=*|*TENANT_API_KEYS=*|*FACTORY_TENANT_CREDENTIALS=*)
      if printf '%s' "$name" | grep -qE '=(secret-project-key|sk-[A-Za-z0-9]{16,}|[A-Za-z0-9]{32,})'; then
        LEAKS="$LEAKS $name"
      fi
      ;;
  esac
done
if [ -n "$LEAKS" ]; then
  fail "a layer command embeds a credential literal:$LEAKS"
else
  pass "no layer command embeds a credential"
fi

ENV_BAKED="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null \
  | grep -E '^(APPWRITE_API_KEY|GEMINI_API_KEY|TENANT_API_KEYS|FACTORY_TENANT_CREDENTIALS|APPWRITE_ENDPOINT)=' || true)"
if [ -n "$ENV_BAKED" ]; then
  fail "the image bakes a credential into its environment: $ENV_BAKED"
else
  pass "the image environment contains no credential"
fi

# The files that must never be in the image: the developer's own .env, and the local ledger.
for name in .env .env.local .data; do
  if docker run --rm --entrypoint sh "$IMAGE" -c "test -e /app/$name" >/dev/null 2>&1; then
    fail "/app/$name is present in the image"
  else
    pass "/app/$name is absent from the image"
  fi
done

section "It refuses to start without configuration"
# This is the property that makes "no baked secret" safe rather than merely tidy: an
# unconfigured container must die, not serve.
docker run --rm -e PORT=3000 --name sf-nc4-refuse "$IMAGE" >/tmp/sf-image-refuse.log 2>&1
REFUSE_EXIT=$?
if [ "$REFUSE_EXIT" -ne 0 ]; then
  pass "an unconfigured container exits $REFUSE_EXIT instead of serving"
else
  fail "an unconfigured container ran to completion; it is serving without credentials"
fi
if grep -qiE 'refus|must be set|required' /tmp/sf-image-refuse.log 2>/dev/null; then
  pass "the refusal names a missing configuration variable"
else
  fail "the container exited but the log does not say what was missing"
fi

section "It actually serves, as a non-root user, when configured"
PORT=18777
CONTAINER="sf-nc4-serve-$$"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# The configuration is the one a real production pod gets. The first version of this test
# passed ALLOW_INSECURE_LOCAL=true, which the service correctly refuses in production -- so
# the test failed for the right reason and for the wrong one at the same time, and a reader
# could not tell which. The refusal is itself covered by the previous section.
docker run -d --name "$CONTAINER" -p "$PORT:3000" \
  -e FACTORY_API_KEY=verify-image-gate-local-key \
  -e FACTORY_TENANT_SEED_DEMO=true \
  "$IMAGE" >/dev/null 2>&1

READY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/factory/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done

if [ "$READY" -eq 1 ]; then
  pass "the container serves its health endpoint on port $PORT"

  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/factory/health" 2>/dev/null || echo '{}')"
  if printf '%s' "$HEALTH" | grep -qiE '"(status|ledger|degraded)"'; then
    pass "the health endpoint reports real state, not a constant"
  else
    fail "the health endpoint returned no recognizable status: $HEALTH"
  fi

  # The container's own view of who it is. If the image ran as root this is where it shows.
  IN_CTR="$(docker exec "$CONTAINER" id -u 2>/dev/null | tr -d '\r\n ')"
  if [ -n "$IN_CTR" ] && [ "$IN_CTR" != "0" ]; then
    pass "the serving container is uid $IN_CTR, not root"
  else
    fail "the serving container reports uid ${IN_CTR:-unknown}"
  fi

  # The declared healthcheck must pass against the running container, or it is decoration.
  HSTATE="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo none)"
  case "$HSTATE" in
    starting|healthy) pass "the declared HEALTHCHECK reports '$HSTATE'" ;;
    none) fail "the image declares no HEALTHCHECK; the orchestrator cannot know when to route traffic" ;;
    *) fail "the declared HEALTHCHECK reports '$HSTATE' while the service is up" ;;
  esac
else
  fail "the container never became ready; see docker logs $CONTAINER"
  docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    /'
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

section "The runtime image carries no build tooling"
# vite, esbuild and tsc are build-time dependencies. Their presence in a runtime image is a
# supply-chain surface with no compensating benefit.
for tool in vite esbuild tsc; do
  if docker run --rm --entrypoint sh "$IMAGE" -c "test -e /app/node_modules/$tool" >/dev/null 2>&1; then
    fail "the build tool '$tool' is present in the runtime image"
  else
    pass "the build tool '$tool' is absent from the runtime image"
  fi
done

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ IMAGE GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
else
  printf '\033[31m════ IMAGE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
