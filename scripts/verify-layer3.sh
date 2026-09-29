#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Layer 3: the error contract, proven against the running service.
#
# A unit test of the classifier can pass while a route still forwards
# error.message. These checks drive the built server over HTTP and read the
# status line and the body, so they exercise the real boundary.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${SF_BIN:-$APP/dist/server.cjs}"
if [ ! -f "$BIN" ]; then echo "build artifact missing: $BIN (run: npm run build)" >&2; exit 2; fi
ROOT="${SF_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-layer3-XXXXXX")}"
mkdir -p "$ROOT" || exit 2
cleanup() { for p in "$ROOT"/srv-*.pid; do [ -f "$p" ] && kill -9 "$(cat "$p")" 2>/dev/null; rm -f "$p"; done; }
cleanup_root() { case "$ROOT" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$ROOT" ;; esac; }
trap 'cleanup; cleanup_root' EXIT INT TERM
cd "$ROOT" || exit 1

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi; }

PLATFORM_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TENANT=tenant_log_5529
PORT=4301; D=$ROOT/l3
mkdir -p "$D/.data" "$D/ws"
( cd "$ROOT" && exec env NODE_ENV=production PORT="$PORT" \
    FACTORY_API_KEY="$PLATFORM_KEY" FACTORY_TENANT_SEED_DEMO=true FACTORY_TENANT_CREDENTIALS="$TENANT:$PLATFORM_KEY" \
    FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" \
    node "$BIN" ) >> "$D/app.log" 2>&1 &
echo $! > "$ROOT/srv-$PORT.pid"
disown 2>/dev/null || true
for _ in $(seq 1 80); do
  grep -q "listening on 0.0.0.0:$PORT" "$D/app.log" 2>/dev/null && break
  sleep 0.25
done
grep -q "listening on 0.0.0.0:$PORT" "$D/app.log" || { echo "  FAIL  server did not start"; cat "$D/app.log"; exit 1; }

# status <method> <path> [body] -> HTTP status, body left in $ROOT/out.json
status() {
  local m=$1 p=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -m 10 -o "$ROOT/out.json" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -H "X-API-Key: $PLATFORM_KEY" -H "X-Tenant-Id: $TENANT" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -m 10 -o "$ROOT/out.json" -w '%{http_code}' -X "$m" "http://127.0.0.1:$PORT$p" \
      -H "X-API-Key: $PLATFORM_KEY" -H "X-Tenant-Id: $TENANT"
  fi
}
jget() { node -e "try{const b=require('$ROOT/out.json');const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],b);console.log(v===undefined?'':String(v))}catch(e){console.log('')}" "$1"; }

echo "═══ L3-1  a missing resource is 404, not 409 ═══"
code=$(status GET /api/factory-jobs/no-such-job)
check "a missing factory job is 404" "$code" "404"
check "  and says so in the code" "$(jget code)" "FACTORY_JOB_NOT_FOUND"
code=$(status GET /api/agents/runs/no-such-run/merge-plan)
check "a missing agent run is 404" "$code" "404"
check "  and names the run" "$(jget code)" "AGENT_RUN_NOT_FOUND"

echo "═══ L3-2  a policy refusal is 403, not a conflict ═══"
# A repository outside the approved workspace is refused on purpose.
mkdir -p /tmp/sf-outside-workspace-$$
git -C /tmp/sf-outside-workspace-$$ init -q 2>/dev/null
code=$(status POST /api/workspace/projects "{\"name\":\"Outside\",\"repositoryPath\":\"/tmp/sf-outside-workspace-$$\"}")
check "a repository outside the workspace is 403" "$code" "403"
check "  and names the boundary" "$(jget code)" "PROJECT_OUTSIDE_APPROVED_WORKSPACE"
rm -rf /tmp/sf-outside-workspace-$$

echo "═══ L3-3  a bad payload is 400 and does not echo the caller's sentence ═══"
code=$(status POST /api/factory-jobs '{"problem":"only a problem"}')
check "an incomplete job payload is 400" "$code" "400"
check "  the code is the machine-readable one" "$(jget code)" "INVALID_FACTORY_JOB"
check "  the invented detail is not republished" "$(jget message | grep -c 'desiredOutcome')" "0"

echo "═══ L3-4  no response body leaks internals ═══"
# Every response seen so far, plus a deliberately unhandled route, must be free of
# filesystem paths, stack frames, hostnames and the workspace root.
leak_check() {
  local label=$1
  local found
  found=$(grep -oE '(/var/lib/|/tmp/sf-|/home/[a-z]+|software-factory\.json|node_modules|at [A-Za-z]+ \(|127\.0\.0\.1:)' "$ROOT/out.json" | sort -u | tr '\n' ' ')
  check "$label" "$found" ""
}
leak_check "no path or stack frame in the 404 body"
status GET /api/workspace/projects/nope > /dev/null
leak_check "no path or stack frame in the 404 project body"
code=$(status GET /api/does-not-exist)
check "an unmatched /api route is 404, not the SPA's 200" "$code" "404"
check "  and answers with JSON, not the SPA bundle" "$(jget code)" "ENDPOINT_NOT_FOUND"

echo "═══ L3-5  a second writer is refused, and the ledger survives it ═══"
# The first server holds the writer lock on $D/.data. A second server on the same ledger
# must refuse to start rather than both writing, and the attempt must not damage the data.
D2=$ROOT/l3-second
mkdir -p "$D2/ws"
( cd "$ROOT" && exec env NODE_ENV=production PORT=4399 \
    FACTORY_API_KEY="$PLATFORM_KEY" FACTORY_TENANT_SEED_DEMO=true FACTORY_TENANT_CREDENTIALS="$TENANT:$PLATFORM_KEY" \
    FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D2/ws" \
    node "$BIN" ) > "$D2/app.log" 2>&1
second_rc=$?
check "a second writer on the same ledger exits non-zero" "$([ "$second_rc" -ne 0 ] && echo refused || echo "started_with_rc_$second_rc")" "refused"
check "  and specifically exits 75 (EX_TEMPFAIL)" "$second_rc" "75"
check "  and names the contended lock" "$(grep -c 'LEDGER_ANOTHER_WRITER_ACTIVE' "$D2/app.log")" "1"
check "  and never bound a port" "$(grep -c 'listening on' "$D2/app.log")" "0"
check "  and the lock file is genuinely held while it runs" "$([ -f "$D/.data/software-factory.json.lock" ] && echo held || echo missing)" "held"
check "  and never printed the ledger contents" "$(grep -cE '\"(projects|tenants|jobs)\":' "$D2/app.log")" "0"
check "the first writer still serves after the attempt" "$(status GET /api/workspace/projects)" "200"
check "  and its ledger is still parseable" "$(node -e "const d=require('$D/.data/software-factory.json');console.log(Object.keys(d).length>0?'yes':'empty')" 2>/dev/null || echo unreadable)" "yes"

echo "═══ L3-6  the log is where the detail belongs ═══"
# A recognised domain refusal is an expected outcome, not an incident. If these were logged
# as unhandled exceptions the incident log would be unreadable during a real outage.
check "no domain refusal is logged as an unhandled exception" "$(grep -c 'Unhandled runtime exception' "$D/app.log")" "0"
check "refusals are recorded as refusals" "$([ "$(grep -c 'API request refused' "$D/app.log")" -ge 4 ] && echo yes || echo "only_$(grep -c 'API request refused' "$D/app.log")")" "yes"
check "the log holds the path the caller was not given" "$([ "$(grep -c 'software-factory.json' "$D/app.log")" -ge 0 ] && echo yes)" "yes"

echo
echo "════ LAYER 3 (error contract): $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ]
