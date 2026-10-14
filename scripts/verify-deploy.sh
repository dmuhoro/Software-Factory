#!/usr/bin/env bash
#
# Sprint 30 (WP-4): the deployment preflight, exercised against the real runtime entrypoint.
#
# `server.ts` refuses to bind a port on an unusable configuration and exits 78 (EX_CONFIG). That
# claim is only worth anything if the *documented* path actually invokes it. This harness runs the
# exact command the image and Railway run -- `node dist/server.cjs` -- three ways:
#
#   1. a production deploy with a known-placeholder credential  -> must refuse to start (exit 78)
#   2. a production deploy with the loopback bypass enabled      -> must refuse to start (exit 78)
#   3. a correctly-configured production deploy                  -> must bind and answer /api/factory/health
#
# It waits for the startup banner (not merely a TCP answer) so a check cannot race the process it is
# inspecting, and never leaves a server behind. Because the container's CMD, the Railway start
# command and this harness are the same command, a green run here means the deployed entrypoint is
# the one under test -- not a test double.
#
# Usage: scripts/verify-deploy.sh   (requires `npm run build` first)
#   SF_BIN       server bundle under test (default: dist/server.cjs)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Ambient shell config must not decide whether this gate passes.
# shellcheck source=scripts/verify-env.sh
. "$HERE/verify-env.sh"

APP="$(cd "$HERE/.." && pwd)"
BIN="${SF_BIN:-$APP/dist/server.cjs}"
if [ ! -f "$BIN" ]; then echo "build artifact missing: $BIN (run: npm run build)" >&2; exit 2; fi

WORK="${SF_DEPLOY_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-deploy-XXXXXX")}"
mkdir -p "$WORK" || exit 2
cd "$WORK" || exit 1

PASS=0; FAIL=0
SRV_PID=""
cleanup() { if [ -n "$SRV_PID" ]; then kill -9 "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; fi; rm -f "$WORK"/srv.pid; }
cleanup_work() { case "$WORK" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$WORK" ;; esac; }
trap 'cleanup; cleanup_work' EXIT INT TERM

check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi; }

free_port() {
  node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})'
}

# run_expecting_refusal <label> <env assignments...>
run_expecting_refusal() {
  local label="$1"; shift
  local out rc
  out="$(env NODE_ENV=production CONTROLLED=1 "$@" node "$BIN" 2>&1)"; rc=$?
  check "$label refuses to start (exit 78)" "$rc" "78"
  case "$out" in
    *"refusing to start"*) check "$label names the refusal" "yes" "yes" ;;
    *) echo "    refusal output was: $(printf '%s' "$out" | head -c 200)"; check "$label names the refusal" "no" "yes" ;;
  esac
}

echo "== 1. a misconfigured production deploy refuses to start =="
run_expecting_refusal "placeholder credential" \
  FACTORY_API_KEY=replace-with-a-long-random-secret \
  FACTORY_DATA_DIR="$WORK/data-bad"

run_expecting_refusal "loopback bypass in production" \
  FACTORY_API_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  ALLOW_INSECURE_LOCAL=true \
  FACTORY_DATA_DIR="$WORK/data-bad2"

echo "== 2. the documented deploy boots and answers its health check =="
PORT="$(free_port)"; SRV_PID=""
mkdir -p "$WORK/data" "$WORK/ws"
: > "$WORK/srv.log"
( cd "$WORK" && exec env NODE_ENV=production PORT="$PORT" \
    FACTORY_API_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    FACTORY_DATA_DIR="$WORK/data" \
    FACTORY_WORKSPACE_ROOT="$WORK/ws" \
    node "$BIN" ) > "$WORK/srv.log" 2>&1 &
SRV_PID=$!

BANNER=""
for _ in $(seq 1 40); do
  if grep -q "listening on" "$WORK/srv.log" 2>/dev/null; then BANNER="yes"; break; fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
check "the configured deploy reaches the startup banner" "${BANNER:-no}" "yes"
if [ "${BANNER:-no}" = "yes" ]; then
  echo "    banner: $(grep 'listening on' "$WORK/srv.log" | tail -1 | sed 's/^\[Software Factory\] //')"
fi

code="$(curl -s -m 8 -o "$WORK/health.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/factory/health" || echo 000)"
check "GET /api/factory/health answers 200" "$code" "200"
if [ -f "$WORK/health.json" ]; then
  node -e 'const b=require(process.argv[1]);if(b.status!=="healthy"&&b.status!=="degraded"){process.exit(1)}' "$WORK/health.json" 2>/dev/null
  check "the health body reports a serveable status" "$?" "0"
fi

cleanup
stopped="alive"
for _ in $(seq 1 20); do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then stopped="stopped"; break; fi
  sleep 0.25
done
check "the deploy process is stopped after the probe" "$stopped" "stopped"

echo
echo "=============================== DEPLOY GATE: $PASS passed, $FAIL failed ==============================="
[ "$FAIL" -eq 0 ]
