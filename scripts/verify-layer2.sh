#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Ambient shell config must not decide whether a layer test passes. See scripts/verify-env.sh.
# shellcheck source=scripts/verify-env.sh
. "$HERE/verify-env.sh"

# LAYER 2 END-TO-END VERIFICATION — tenant isolation and quota enforcement.
#
# The Phase 1 audit proved that a single leaked FACTORY_API_KEY granted every tenant's
# data: authentication compared the caller's key against that one global value and then
# believed whatever X-Tenant-Id header followed. This harness proves that is closed.
#
# Same discipline as Layer 1: one port and data dir per scenario, PID captured and
# reaped, and a control configured so that exactly one guard can fire — a blanket
# refusal would pass every assertion while proving nothing.
#
# Usage: scripts/verify-layer2.sh   (requires `npm run build` first)
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${SF_BIN:-$APP/dist/server.cjs}"
if [ ! -f "$BIN" ]; then echo "build artifact missing: $BIN (run: npm run build)" >&2; exit 2; fi
ROOT="${SF_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-layer2-XXXXXX")}"
mkdir -p "$ROOT" || exit 2
cleanup() { for p in "$ROOT"/srv-*.pid; do [ -f "$p" ] && kill -9 "$(cat "$p")" 2>/dev/null; rm -f "$p"; done; }
cleanup_root() { case "$ROOT" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$ROOT" ;; esac; }
trap 'cleanup; cleanup_root' EXIT INT TERM
cd "$ROOT" || exit 1

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi; }
check_not() { if [ "$2" != "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (must not be '$3')"; FAIL=$((FAIL+1)); fi; }

PLATFORM_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ALICE_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BOB_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
UNPROVISIONED_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ALICE=tenant_hc_1042     # healthcare
BOB=tenant_log_5529      # logistics -- PROFESSIONAL tier, the lowest limit

start_server() {
  local port=$1 data=$2 ws=$3 logfile=$4; shift 4
  mkdir -p "$data" "$ws"; : > "$logfile"
  # `exec` is required: backgrounding `cd ... && env ... node` makes $! the pid of the
  # wrapping subshell, so the EXIT trap kills the wrapper and leaks a listening server
  # that squats the port and 401s the next run. With exec the recorded pid IS node.
  ( cd "$ROOT" && exec env NODE_ENV=production PORT="$port" FACTORY_API_KEY="$PLATFORM_KEY" \
      FACTORY_TENANT_SEED_DEMO=true \
      FACTORY_TENANT_CREDENTIALS="$ALICE:$ALICE_KEY,$BOB:$BOB_KEY" \
      FACTORY_DATA_DIR="$data" FACTORY_WORKSPACE_ROOT="$ws" \
      "$@" node "$BIN" ) >> "$logfile" 2>&1 &
  echo $! > "$ROOT/srv-$port.pid"
  # Disown so the EXIT trap's kill does not make bash print a "Killed" job notice.
  disown 2>/dev/null || true
  for _ in $(seq 1 80); do
    grep -q "listening on 0.0.0.0:$port" "$logfile" 2>/dev/null && return 0
    kill -0 "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
stop_server() { local port=$1; [ -f "$ROOT/srv-$port.pid" ] && kill -9 "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null; rm -f "$ROOT/srv-$port.pid"; sleep 0.5; }

# code <method> <path> <apikey> <tenant> [body] -> HTTP status
code() {
  local method=$1 path=$2 key=$3 tenant=$4 body=${5:-}
  local args=(-s -m 10 -o "$ROOT/out.json" -w '%{http_code}' -X "$method" "http://127.0.0.1:$PORT$path"
              -H "X-API-Key: $key" -H "Content-Type: application/json")
  [ -n "$tenant" ] && args+=(-H "X-Tenant-Id: $tenant")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}
body_has() { grep -c "$1" "$ROOT/out.json"; }

echo "═══ L2-1  a tenant credential is bound to its own partition ═══"
PORT=4201; D=$ROOT/l2-1
start_server $PORT "$D/.data" "$D/ws" "$D/app.log" || { echo "  FAIL  server did not start"; cat "$D/app.log"; exit 1; }
grep -q "provisioned 2 tenant credential" "$D/app.log"
check "both tenant credentials were provisioned" "$?" "0"

got=$(code GET /api/workspace/projects "$ALICE_KEY" "$ALICE")
check "tenant credential authenticates for its own tenant" "$got" "200"
got=$(code GET /api/workspace/projects "$ALICE_KEY" "$BOB")
check "the same credential is refused for another tenant" "$got" "403"
check "  and the reason is a credential mismatch, not a generic denial" "$(body_has TENANT_CREDENTIAL_MISMATCH)" "1"

echo "═══ L2-2  the audited exploit: one key, every tenant ═══"
# The original proof: present a single valid credential, claim a different tenant.
got=$(code GET /api/workspace/projects "$ALICE_KEY" "$BOB")
check "cross-tenant READ refused" "$got" "403"
got=$(code POST /api/workspace/projects "$ALICE_KEY" "$BOB" '{"name":"intruder"}')
check "cross-tenant WRITE refused" "$got" "403"
# A mismatch hidden in the body or query while the header looks innocent must not pass.
got=$(code POST "/api/workspace/projects?tenantId=$BOB" "$ALICE_KEY" "" "{\"tenantId\":\"$BOB\",\"name\":\"intruder\"}")
check "cross-tenant claim hidden in the body is still refused" "$got" "403"
got=$(code GET "/api/workspace/projects?tenantId=$BOB" "$ALICE_KEY" "" "")
check "cross-tenant claim hidden in the query string is still refused" "$got" "403"
check "cross-tenant attempts are recorded in the audit trail" "$(grep -c 'Cross-tenant access refused' "$D/app.log" | awk '{print ($1>0)?"yes":"no"}')" "yes"

echo "═══ L2-3  tenant data cannot be conflated ═══"
# Alice writes under her own partition; Bob must not be able to read or overwrite it.
# Registration requires repositoryPath to be a real git repository inside the workspace.
mkdir -p "$D/ws/alice-project"
git -C "$D/ws/alice-project" init -q
created=$(code POST /api/workspace/projects "$ALICE_KEY" "$ALICE" "{\"name\":\"Alice Confidential\",\"repositoryPath\":\"$D/ws/alice-project\"}")
check "Alice can create a project in her own partition" "$created" "201"
code GET /api/workspace/projects "$ALICE_KEY" "$ALICE" > /dev/null
alice_count=$(node -e "const b=require('$ROOT/out.json'); console.log((b.projects||[]).length)")
check "Alice sees her own project" "$alice_count" "1"
bob_status=$(code GET /api/workspace/projects "$BOB_KEY" "$BOB")
check "Bob can read his own partition (proves the check is not vacuous)" "$bob_status" "200"
bob_count=$(node -e "const b=require('$ROOT/out.json'); console.log((b.projects||[]).length)")
check "Bob does not see Alice's project" "$bob_count" "0"
bob_alice=$(node -e "const b=require('$ROOT/out.json'); console.log(JSON.stringify(b).includes('Alice Confidential'))")
check "Alice's project name never appears in Bob's response" "$bob_alice" "false"
check "no credential value appears in the log" "$(grep -c "$ALICE_KEY" "$D/app.log")" "0"
check "no credential value appears in the platform key either" "$(grep -c "$PLATFORM_KEY" "$D/app.log")" "0"

echo "═══ L2-4  unprovisioned and unknown credentials ═══"
got=$(code GET /api/workspace/projects "$UNPROVISIONED_KEY" "$BOB")
check "an unprovisioned credential is refused" "$got" "401"
got=$(code GET /api/workspace/projects "$UNPROVISIONED_KEY" "")
check "an unknown credential without a claim is refused the same way" "$got" "401"
got=$(code GET /api/workspace/projects "$UNPROVISIONED_KEY" "tenant_does_not_exist")
check "refusal does not reveal whether the tenant exists" "$got" "401"

echo "═══ L2-5  the platform key is an operator credential, and is audited ═══"
got=$(code GET /api/workspace/projects "$PLATFORM_KEY" "$BOB")
check "platform key may act for any tenant" "$got" "200"
check "cross-tenant platform use is recorded" "$(grep -c 'Platform credential used' "$D/app.log" | awk '{print ($1>0)?"yes":"no"}')" "yes"
stop_server $PORT

echo "═══ L2-6  rate limiting is keyed on the authenticated tenant ═══"
PORT=4202; D=$ROOT/l2-6
start_server $PORT "$D/.data" "$D/ws" "$D/app.log" || { echo "  FAIL  server did not start"; cat "$D/app.log"; exit 1; }
# tenant_log_5529 is on the PROFESSIONAL tier: 300 requests/minute, burst 50, so the
# bucket refills at 5 tokens/second. A SEQUENTIAL loop can never exhaust it, because the
# client cannot issue requests faster than the refill rate -- that is a client-speed limit,
# not a server control. The requests are therefore issued concurrently.
probe() { curl -s -m 5 -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/workspace/projects" -H "X-API-Key: $BOB_KEY" -H "X-Tenant-Id: $BOB"; }
export -f probe
export PORT BOB BOB_KEY
split=$(seq 1 150 | xargs -P 30 -I{} bash -c probe | sort | uniq -c)
refused=$(echo "$split" | awk '$2==429 {print $1}')
allowed=$(echo "$split" | awk '$2==200 {print $1}')
check "an authenticated tenant is throttled by its own quota" "$([ "${refused:-0}" -ge 20 ] && echo yes || echo "only_$refused")" "yes"
# The burst is 50 and refill is 5/s, so a small number of successes must still be allowed.
# If everything were refused the limiter would be a hard denial, not a quota.
check "the quota allows a burst before refusing" "$([ "${allowed:-0}" -ge 1 ] && echo yes || echo none)" "yes"

# The original rate-limit bypass was a spoofed tenant header creating a fresh bucket.
# Those requests are now refused at authentication, so they can never reach the limiter
# and can never mint a new bucket. Assert the refusal is 403, not 429, to prove which
# layer caught it. Alice is used here because Bob's bucket is now deliberately empty.
spoofed=0; throttled=0
for i in $(seq 1 10); do
  got=$(code GET /api/workspace/projects "$ALICE_KEY" "spoofed-tenant-$i")
  [ "$got" = "403" ] && spoofed=$((spoofed+1))
  [ "$got" = "429" ] && throttled=$((throttled+1))
done
check "a spoofed tenant header is refused at authentication" "$spoofed" "10"
check "a spoofed tenant header never reaches the rate limiter" "$throttled" "0"
# Alice is on the ENTERPRISE tier: 2000 rpm. A hardcoded 120 would report a different number.
reported=$(curl -s -m 10 -D - -o /dev/null "http://127.0.0.1:$PORT/api/workspace/projects" -H "X-API-Key: $ALICE_KEY" -H "X-Tenant-Id: $ALICE" | grep -i '^x-ratelimit-limit' | tr -d '\r' | awk '{print $2}')
check "the limiter reports the tenant tier quota, not a hardcoded 120" "$reported" "2000"
stop_server $PORT

echo
echo "════ LAYER 2: $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ]
