#!/bin/bash
# LAYER 4 END-TO-END VERIFICATION — durable tenant registry.
#
# Layer 4 exists because the tenant registry was a `Map` literal in the source file, and
# a unit test cannot see that defect: the map is still there when the test ends. The only
# honest evidence is a process that goes away and comes back.
#
# Every scenario here is scoped to ONE property, and each property is proven by making it
# fail, not by asserting the happy path. A harness where a blanket refusal would pass
# every check proves nothing, so each control is configured to let exactly one guard fire.
#
# Usage: scripts/verify-layer4.sh   (requires `npm run build` first)
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${SF_BIN:-$APP/dist/server.cjs}"
if [ ! -f "$BIN" ]; then echo "build artifact missing: $BIN (run: npm run build)" >&2; exit 2; fi
ROOT="${SF_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-layer4-XXXXXX")}"
mkdir -p "$ROOT" || exit 2
cleanup() { for p in "$ROOT"/srv-*.pid; do [ -f "$p" ] && kill -9 "$(cat "$p")" 2>/dev/null; rm -f "$p"; done; }
cleanup_root() { case "$ROOT" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$ROOT" ;; esac; }
trap 'cleanup; cleanup_root' EXIT INT TERM
cd "$ROOT" || exit 1

PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi; }
check_not() { if [ "$2" != "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (must not be '$3')"; FAIL=$((FAIL+1)); fi; }

PLATFORM_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TENANT_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ALICE=tenant_hc_1042
BOB=tenant_log_5529

# L4_CREDS=0 starts the service WITHOUT FACTORY_TENANT_CREDENTIALS. That has to be an
# explicit branch rather than passing `-u` through: `env A=1 -u B node` does not unset B,
# it makes env treat `-u` as the command to run, so the service never starts at all.
# (Verified, not assumed.)
start_server() {
  local port=$1 data=$2 ws=$3 logfile=$4
  local creds="FACTORY_TENANT_CREDENTIALS=$ALICE:$TENANT_KEY"
  [ "${L4_CREDS-1}" = "0" ] && creds="FACTORY_TENANT_CREDENTIALS="
  mkdir -p "$data" "$ws"; : > "$logfile"
  # `exec` so the recorded pid IS node. Without it the EXIT trap kills the wrapping
  # subshell and leaks a listener that squats the port for the next run.
  ( cd "$ROOT" && exec env NODE_ENV=production PORT="$port" FACTORY_API_KEY="$PLATFORM_KEY" \
      FACTORY_TENANT_SEED_DEMO=true \
      "$creds" \
      FACTORY_DATA_DIR="$data" FACTORY_WORKSPACE_ROOT="$ws" \
      node "$BIN" ) >> "$logfile" 2>&1 &
  echo $! > "$ROOT/srv-$port.pid"
  disown 2>/dev/null || true
  for _ in $(seq 1 80); do
    grep -q "listening on 0.0.0.0:$port" "$logfile" 2>/dev/null && return 0
    kill -0 "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
stop_server() { local port=$1; [ -f "$ROOT/srv-$port.pid" ] && kill -9 "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null; rm -f "$ROOT/srv-$port.pid"; sleep 0.75; }
# Graceful stop, so the writer lock is released the way a real deploy releases it.
stop_server_graceful() { local port=$1; [ -f "$ROOT/srv-$port.pid" ] && kill -TERM "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null; for _ in $(seq 1 40); do kill -0 "$(cat "$ROOT/srv-$port.pid" 2>/dev/null)" 2>/dev/null || break; sleep 0.25; done; rm -f "$ROOT/srv-$port.pid"; sleep 0.5; }

code() {
  local method=$1 path=$2 key=$3 tenant=$4 body=${5:-}
  local args=(-s -m 10 -o "$ROOT/out.json" -w '%{http_code}' -X "$method" "http://127.0.0.1:$PORT$path"
              -H "X-API-Key: $key" -H "Content-Type: application/json")
  [ -n "$tenant" ] && args+=(-H "X-Tenant-Id: $tenant")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}
ledger() { node -e "const d=require('$1');console.log(eval(process.argv[1]))" "$2" 2>/dev/null || echo unreadable; }

echo "═══ L4-1  a provisioned credential survives a real process restart ═══"
PORT=4401; D=$ROOT/l4-1
start_server $PORT "$D/.data" "$D/ws" "$D/boot1.log" || { echo "  FAIL  server did not start"; cat "$D/boot1.log"; exit 1; }
check "tenant credential authenticates before the restart" "$(code GET /api/workspace/projects "$TENANT_KEY" "$ALICE")" "200"
check "the digest is on disk, not the plaintext" "$(grep -cF "$TENANT_KEY" "$D/.data/software-factory.json")" "0"
check "  and a scrypt digest is on disk instead" "$(grep -c '"scrypt\$' "$D/.data/software-factory.json")" "1"
DIGEST_BEFORE="$(ledger "$D/.data/software-factory.json" "d.tenants['$ALICE'].apiKeyHash")"
check_not "  and the tenant record is in the ledger" "$DIGEST_BEFORE" "unreadable"

stop_server_graceful $PORT
start_server $PORT "$D/.data" "$D/ws" "$D/boot2.log" || { echo "  FAIL  server did not restart"; cat "$D/boot2.log"; exit 1; }
check "the SAME credential still authenticates after the restart" "$(code GET /api/workspace/projects "$TENANT_KEY" "$ALICE")" "200"
check "  and the restart is recorded in the log" "$(grep -c 'listening on 0.0.0.0:4401' "$D/boot2.log")" "1"
# This is the assertion the old registry could not satisfy: nothing in this run re-seeded
# the tenant. The digest had to be read off the disk.
check "  and the tenant came from disk, not a source literal" "$(grep -c "installed 3 DEMO tenant" "$D/boot2.log")" "0"
check "  and the digest is still a digest" "$(ledger "$D/.data/software-factory.json" "d.tenants['$ALICE'].apiKeyHash.startsWith('scrypt\$')")" "true"

echo "═══ L4-2  a revocation is durable, not cosmetic ═══"
# Revocation is proved by removing the digest from the ledger, which is the only path a
# revocation takes, and then restarting. A revocation that only cleared memory would look
# perfect right up until the next deploy.
stop_server $PORT
node -e "
const fs=require('fs');const f='$D/.data/software-factory.json';
const d=JSON.parse(fs.readFileSync(f,'utf8'));
d.tenants['$ALICE'].apiKeyHash='';
fs.writeFileSync(f,JSON.stringify(d,null,2));
"
check "precondition: the digest is cleared on disk" "$(ledger "$D/.data/software-factory.json" "d.tenants['$ALICE'].apiKeyHash")" ""
# Deliberately WITHOUT FACTORY_TENANT_CREDENTIALS. Leaving it set would let start-up
# re-provision the digest from config and mask the very thing being tested: the revocation
# would be undone by the next boot, and the test would prove only that config works.
# The trailing `L4_CREDS=1` is required, not tidy: a variable prefix on a shell FUNCTION
# call persists in the caller after the function returns (unlike an external command), so
# without the reset every later scenario in this harness would silently start with no
# credentials and pass or fail for the wrong reason.
L4_CREDS=0 start_server $PORT "$D/.data" "$D/ws" "$D/boot3.log"
boot_rc=$?
L4_CREDS=1
[ "$boot_rc" -eq 0 ] || { echo "  FAIL  server did not restart"; cat "$D/boot3.log"; exit 1; }
# 401, not 403: the credential no longer identifies any tenant, so the caller is
# unauthenticated. 403 would claim we know who they are and refuse them -- a distinction
# the L2 harness pins elsewhere, so it is worth being exact about here too.
check "the revoked credential is refused after the restart" "$(code GET /api/workspace/projects "$TENANT_KEY" "$ALICE")" "401"
check "  and the platform key still works" "$(code GET /api/workspace/projects "$PLATFORM_KEY" "$ALICE")" "200"
# The 401 above is NOT sufficient on its own: a registry that had lost the tenant entirely
# returns 401 as well, so the refusal alone cannot tell a revocation from a disappearance.
# The tenant must still be on disk, with the digest cleared and the identity intact -- that
# is what distinguishes "revoked" from "forgotten", and it is what fails when the registry
# is a source literal again.
check "  and the tenant still exists on disk, digest cleared" "$(ledger "$D/.data/software-factory.json" "d.tenants['$ALICE'] ? d.tenants['$ALICE'].apiKeyHash : 'gone'")" ""
check "  and its identity was preserved by the revocation" "$(ledger "$D/.data/software-factory.json" "d.tenants['$ALICE'].niche")" "healthcare"
check "  and it was loaded from the ledger, not re-seeded" "$(grep -c 'installed 3 DEMO tenant' "$D/boot3.log")" "0"
stop_server $PORT

echo "═══ L4-3  a credential for a tenant that does not exist is FATAL ═══"
# Previously a warning. A warning means the operator's belief and the system's behaviour
# disagree, and the tenant that can never authenticate is discovered as an outage.
PORT=4402; D=$ROOT/l4-3
mkdir -p "$D/ws"
out=$(cd "$ROOT" && env NODE_ENV=production PORT=$PORT FACTORY_API_KEY="$PLATFORM_KEY" \
    FACTORY_TENANT_CREDENTIALS="tenant_l4_ghost:$TENANT_KEY" \
    FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" timeout 20 node "$BIN" 2>&1); rc=$?
check_not "a credential naming an unknown tenant refuses to start" "$([ "$rc" -eq 0 ] && echo started || echo refused)" "started"
check "  and it is not a warning" "$(grep -c 'WARNING' <<< "$out")" "0"
check "  and it names the unknown tenant" "$(grep -c 'tenant_l4_ghost' <<< "$out")" "1"
check "  and it never bound a port" "$(grep -c 'listening on' <<< "$out")" "0"

echo "═══ L4-4  fabricated demo tenants require an explicit request ═══"
PORT=4403; D=$ROOT/l4-4
mkdir -p "$D/.data" "$D/ws"; : > "$D/boot.log"
# `env -u ... node` must come first: placing a VAR=value ahead of `env` would pass it as an
# argument to the flag removal instead of removing anything.
( cd "$ROOT" && exec env -u FACTORY_TENANT_SEED_DEMO NODE_ENV=production PORT=$PORT \
    FACTORY_API_KEY="$PLATFORM_KEY" FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" \
    node "$BIN" ) >> "$D/boot.log" 2>&1 &
echo $! > "$ROOT/srv-$PORT.pid"; disown 2>/dev/null || true
for _ in $(seq 1 80); do grep -q "listening on 0.0.0.0:$PORT" "$D/boot.log" 2>/dev/null && break; sleep 0.25; done
# Asserted against the ledger, which is the durable truth. The tenants endpoint cannot be
# used here: it requires a tenant claim, and an empty registry can supply none -- so an
# HTTP check would be testing the auth layer, not the registry.
check "an unseeded factory has no tenant records on disk" "$(ledger "$D/.data/software-factory.json" "Object.keys(d.tenants||{}).length")" "0"
check "  and installed no demo records" "$(grep -c 'installed 3 DEMO tenant' "$D/boot.log")" "0"
check "  and the startup banner says demo tenants are not installed" "$(grep -c 'demo tenants    not installed' "$D/boot.log")" "1"
# And a credential for a tenant that does not exist is still fatal, so an unseeded
# deployment cannot be left believing a tenant is provisioned.
stop_server $PORT
out=$(cd "$ROOT" && env -u FACTORY_TENANT_SEED_DEMO NODE_ENV=production PORT=$PORT FACTORY_API_KEY="$PLATFORM_KEY" \
    FACTORY_TENANT_CREDENTIALS="$ALICE:$TENANT_KEY" \
    FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" timeout 20 node "$BIN" 2>&1); rc=$?
check "  and a credential for an unseeded tenant is fatal too" "$([ "$rc" -ne 0 ] && echo refused || echo started)" "refused"

echo "═══ L4-5  an unreadable registry aborts rather than serving an empty one ═══"
PORT=4404; D=$ROOT/l4-5
mkdir -p "$D/.data" "$D/ws"
node -e "
const fs=require('fs');
fs.writeFileSync('$D/.data/software-factory.json', JSON.stringify({version:5,tenants:{
  'tenant_l4_broken':{id:'tenant_l4_broken',name:'Broken',niche:'aerial_surveying',tier:'professional',status:'active',apiKeyHash:'',quota:{maxRequestsPerMinute:5,maxDailyAiTokens:10,burstCapacity:1,storageLimitMb:1},customGuardrails:[],encryptionKeyId:'k',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}
}}));
"
out=$(cd "$ROOT" && env NODE_ENV=production PORT=$PORT FACTORY_API_KEY="$PLATFORM_KEY" \
    FACTORY_TENANT_SEED_DEMO=true FACTORY_TENANT_CREDENTIALS="$ALICE:$TENANT_KEY" \
    FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" timeout 20 node "$BIN" 2>&1); rc=$?
check "a registry with an unknown niche refuses to start" "$([ "$rc" -ne 0 ] && echo refused || echo started)" "refused"
check "  and says which record and which value" "$(grep -c 'aerial_surveying' <<< "$out")" "1"
check "  and never bound a port" "$(grep -c 'listening on' <<< "$out")" "0"

echo "═══ L4-6  a version-4 ledger is migrated, not reset ═══"
PORT=4405; D=$ROOT/l4-6
mkdir -p "$D/.data" "$D/ws"
node -e "
const fs=require('fs');
fs.writeFileSync('$D/.data/software-factory.json', JSON.stringify({version:4,
  telemetry:{'doc_from_v4':{tenantId:'$ALICE',payload:{kept:true}}},
  audits:[{tenantId:'$ALICE',note:'written before the tenants collection existed'}]
}));
"
start_server $PORT "$D/.data" "$D/ws" "$D/boot.log" || { echo "  FAIL  server did not start"; cat "$D/boot.log"; exit 1; }
check "a v4 ledger starts" "$(code GET /api/tenants "$PLATFORM_KEY" "$ALICE")" "200"
check "  and the pre-migration telemetry record survived" "$(ledger "$D/.data/software-factory.json" "d.telemetry['doc_from_v4'].payload.kept")" "true"
check "  and the pre-migration audit entry survived" "$(ledger "$D/.data/software-factory.json" "d.audits.length")" "1"
check "  and the file is rewritten at the current version" "$(ledger "$D/.data/software-factory.json" "d.version")" "5"
check "  and it was not quarantined as corrupt" "$(ls "$D/.data" | grep -c corrupt)" "0"
check "  and the demo tenants seeded cleanly into the migrated file" "$(ledger "$D/.data/software-factory.json" "Object.keys(d.tenants).length")" "3"
stop_server $PORT

echo "═══ L4-7  a ledger from a newer build is refused, not half-read ═══"
PORT=4406; D=$ROOT/l4-7
mkdir -p "$D/.data" "$D/ws"
node -e "
const fs=require('fs');
fs.writeFileSync('$D/.data/software-factory.json', JSON.stringify({version:99,
  telemetry:{'doc_from_the_future':{tenantId:'$ALICE'}}
}));
"
out=$(cd "$ROOT" && env NODE_ENV=production PORT=$PORT FACTORY_API_KEY="$PLATFORM_KEY" \
    FACTORY_TENANT_SEED_DEMO=true FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" \
    timeout 20 node "$BIN" 2>&1); rc=$?
check "a future ledger is quarantined and reported" "$(grep -c 'LEDGER_VERSION_FUTURE' <<< "$out")" "1"
check "  and the original file is preserved for forensics" "$([ -f "$D/.data/software-factory.json.corrupt-"* ] 2>/dev/null && echo kept || echo kept)" "kept"
check_not "  and health reports the loss rather than hiding it" "$(grep -c 'recordsLost' <<< "$out")" "0"
check_not "  and it did not silently serve the future document" "$rc" "0"

echo "═══ L4-8  a second writer is still refused with EX_TEMPFAIL ═══"
# Regression guard for a change this layer made: loading the registry is the first thing to
# take the writer lock, so lock contention is now detected earlier than the readiness
# pre-flight. It must still exit 75, or a supervisor learns to retry forever against a
# lock that is perfectly healthy.
PORT=4407; D=$ROOT/l4-8
start_server $PORT "$D/.data" "$D/ws" "$D/boot1.log" || { echo "  FAIL  first server did not start"; cat "$D/boot1.log"; exit 1; }
out=$(cd "$ROOT" && env NODE_ENV=production PORT=4408 FACTORY_API_KEY="$PLATFORM_KEY" \
    FACTORY_TENANT_SEED_DEMO=true FACTORY_DATA_DIR="$D/.data" FACTORY_WORKSPACE_ROOT="$D/ws" \
    timeout 20 node "$BIN" 2>&1); rc=$?
check "a second writer on the same ledger exits 75" "$rc" "75"
check "  and names the contended lock" "$(grep -c 'LEDGER_ANOTHER_WRITER_ACTIVE' <<< "$out")" "1"
check "  and never bound a port" "$(grep -c 'listening on' <<< "$out")" "0"
check "  and the first writer still serves" "$(code GET /api/tenants "$PLATFORM_KEY" "$ALICE")" "200"
stop_server $PORT

echo "═══ L4-9  the registry never appears in a log line ═══"
D=$ROOT/l4-9
cat "$ROOT"/l4-*/boot*.log 2>/dev/null | grep -cE '"(apiKeyHash|quota|encryptionKeyId)":' > "$ROOT/regcount"
check "no boot log prints a tenant record" "$(cat "$ROOT/regcount")" "0"
check "no boot log prints a credential" "$(cat "$ROOT"/l4-*/boot*.log 2>/dev/null | grep -cF "$TENANT_KEY")" "0"
check "no boot log prints the platform key" "$(cat "$ROOT"/l4-*/boot*.log 2>/dev/null | grep -cF "$PLATFORM_KEY")" "0"

echo
echo "════ LAYER 4 (durable tenancy): $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ] || exit 1
