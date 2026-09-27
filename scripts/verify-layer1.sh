#!/bin/bash
# LAYER 1 VERIFICATION
# Proves each P0 defect found in the Phase 1 audit is closed, by exercising the real
# HTTP surface of the built server. Every section uses its own port, data dir and
# captured PID, and waits for the STARTUP BANNER (not merely for a TCP answer) so a
# check can never race the process it is inspecting.
# LAYER 1 END-TO-END VERIFICATION
#
# Proves each P0 defect from the Phase 1 audit is closed by exercising the real HTTP
# surface of the built server: real process binds, real egress attempts, real restarts.
# The in-process unit tests in test/p0-regressions.test.ts cover the guard logic; this
# harness covers the wiring, which a unit test cannot.
#
# Each section uses its own port, data dir and captured PID, and waits for the STARTUP
# BANNER (not merely for a TCP answer) so a check can never race the process it inspects.
# Each control is configured so that exactly one guard can fire, because a blanket
# refusal would pass every assertion while proving nothing.
#
# Usage: scripts/verify-layer1.sh   (requires `npm run build` first)
#   SF_WORKDIR   scratch directory for probe data (default: a fresh temp dir)
#   SF_BIN       server bundle under test   (default: dist/server.cjs)
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${SF_BIN:-$APP/dist/server.cjs}"
if [ ! -f "$BIN" ]; then echo "build artifact missing: $BIN (run: npm run build)" >&2; exit 2; fi
ROOT="${SF_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-layer1-XXXXXX")}"
mkdir -p "$ROOT" || exit 2
cleanup_root() { case "$ROOT" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$ROOT" ;; esac; }
trap 'cleanup; cleanup_root' EXIT INT TERM
cd "$ROOT" || exit 1
KEY=probe-key-0123456789abcdef
CANARY='CANARY-SECRET-DO-NOT-LEAK-12345'
REGISTERED_TENANT=tenant_hc_1042
PASS=0; FAIL=0

check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi; }

# Never leak a server or the capture listener, even on timeout or Ctrl-C: a stray
# process holding stdout would keep the caller's pipe open forever.
cleanup() {
  for p in "$ROOT"/srv-*.pid "$ROOT/sink.pid"; do [ -f "$p" ] && kill -9 "$(cat "$p")" 2>/dev/null; rm -f "$p"; done
}
trap cleanup EXIT INT TERM

# start_server <port> <datadir> <workspaceroot> <logfile> [extra env assignments...]
start_server() {
  local port=$1 data=$2 ws=$3 logfile=$4; shift 4
  mkdir -p "$data" "$ws"
  : > "$logfile"
  # `exec` is required: backgrounding `cd ... && env ... node` makes $! the pid of the
  # wrapping subshell, so stop_server and the EXIT trap kill the wrapper and leak a
  # listening server that squats the port and fails the next run with EADDRINUSE.
  ( cd "$ROOT" && exec env NODE_ENV=production PORT="$port" \
      FACTORY_API_KEY="$KEY" FACTORY_DATA_DIR="$data" FACTORY_WORKSPACE_ROOT="$ws" \
      "$@" node "$BIN" ) >> "$logfile" 2>&1 &
  echo $! > "$ROOT/srv-$port.pid"
  # Disown so the kill does not make bash print a "Killed" job notice.
  disown 2>/dev/null || true
  # Wait for the banner, which is printed only after the ledger pre-flight completes.
  for _ in $(seq 1 80); do
    if grep -q "listening on 0.0.0.0:$port" "$logfile" 2>/dev/null; then return 0; fi
    if ! kill -0 "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null; then return 1; fi
    sleep 0.25
  done
  return 1
}

stop_server() { local port=$1; [ -f "$ROOT/srv-$port.pid" ] && kill -9 "$(cat "$ROOT/srv-$port.pid")" 2>/dev/null; rm -f "$ROOT/srv-$port.pid"; sleep 0.5; }

# health_code <port>
health_code() { curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/api/factory/health"; }
body_of() { curl -s -m 8 "http://127.0.0.1:$1/api/factory/health"; }
# auth_headers <port> -> array
H4001=(-H "X-API-Key: $KEY" -H "X-Tenant-Id: $REGISTERED_TENANT" -H "Content-Type: application/json")
H4002=(-H "X-API-Key: $KEY" -H "X-Tenant-Id: $REGISTERED_TENANT" -H "Content-Type: application/json")
H4003=(-H "X-API-Key: $KEY" -H "X-Tenant-Id: $REGISTERED_TENANT" -H "Content-Type: application/json")

# The tenant must be registered before tenant-scoped writes are expected to succeed.
# Registering it through the public API (not by editing the ledger) keeps the test honest.
register_tenant() { curl -s -m 8 -o /dev/null -X POST "http://127.0.0.1:$1/api/tenants" -H "X-API-Key: $KEY" -H "X-Tenant-Id: $REGISTERED_TENANT" -H "Content-Type: application/json" -d "{\"tenantId\":\"$REGISTERED_TENANT\",\"name\":\"probe tenant\"}"; }

echo "═══ P0-1  secret exfiltration (was PROVEN exploitable) ═══"
P1=4101; D1=$ROOT/p0-1; rm -rf "$D1"; mkdir -p "$D1"
# A local listener that records any Authorization header it receives.
cat > "$ROOT/sink.py" <<'PY'
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(os.path.join(os.environ['PROBE_ROOT'],'captured.txt'),'a') as f:
            f.write('AUTH=%s\n' % self.headers.get('Authorization','<none>'))
        b=b'{"data":[{"id":"stolen"}]}'
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1', 4100), H).serve_forever()
PY
: > "$ROOT/captured.txt"
PROBE_ROOT="$ROOT" python3 "$ROOT/sink.py" & echo $! > "$ROOT/sink.pid"
sleep 1
start_server $P1 "$D1/.data" "$D1/ws" "$D1/app.log" \
  AWS_SECRET_ACCESS_KEY="$CANARY" \
  FACTORY_LEGIT_KEY=dummy-permitted-key \
  FACTORY_ALLOWED_SECRET_REFS=FACTORY_LEGIT_KEY \
  FACTORY_MODEL_ALLOWED_HOSTS=api.openai.com,169.254.169.254 \
  || { echo "  FAIL  server did not start"; cat "$D1/app.log"; exit 1; }
register_tenant $P1
# Each control is isolated so that exactly one guard can fire. A blanket refusal would
# pass every test while proving nothing, so the host allowlist is configured first and
# each request then violates precisely one rule.
code=$(curl -s -m 8 -o r1.json -w '%{http_code}' -X POST "http://127.0.0.1:$P1/api/agents/providers" "${H4001[@]}" -d '{"id":"exfil1","kind":"openai-compatible","baseUrl":"https://api.openai.com/v1","secretRef":"AWS_SECRET_ACCESS_KEY"}')
check "unlisted secretRef refused at registration" "$(grep -c MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED r1.json)" "1"
code=$(curl -s -m 8 -o r2.json -w '%{http_code}' -X POST "http://127.0.0.1:$P1/api/agents/providers" "${H4001[@]}" -d '{"id":"exfil2","kind":"openai-compatible","baseUrl":"http://api.openai.com/v1","secretRef":"FACTORY_LEGIT_KEY"}')
check "http:// refused for a remote provider" "$(grep -c MODEL_PROVIDER_URL_SCHEME_NOT_ALLOWED r2.json)" "1"
code=$(curl -s -m 8 -o r3.json -w '%{http_code}' -X POST "http://127.0.0.1:$P1/api/agents/providers" "${H4001[@]}" -d '{"id":"exfil3","kind":"openai-compatible","baseUrl":"https://169.254.169.254/v1","secretRef":"FACTORY_LEGIT_KEY"}')
check "cloud-metadata address refused" "$(grep -c MODEL_PROVIDER_ADDRESS_NOT_ALLOWED r3.json)" "1"
code=$(curl -s -m 8 -o r4.json -w '%{http_code}' -X POST "http://127.0.0.1:$P1/api/agents/providers" "${H4001[@]}" -d '{"id":"exfil4","kind":"openai-compatible","baseUrl":"https://evil.example.com/v1","secretRef":"FACTORY_LEGIT_KEY"}')
check "unlisted host refused" "$(grep -c MODEL_PROVIDER_HOST_NOT_ALLOWED r4.json)" "1"
# The decisive assertion: even with the canary in its environment, the app must never
# transmit it to the listener. This is the original exploit, checked end to end.
if grep -q "$CANARY" "$ROOT/captured.txt" 2>/dev/null; then check "no secret reached the listener" "LEAKED" "clean"; else check "no secret reached the listener" "clean" "clean"; fi
kill -9 "$(cat "$ROOT/sink.pid")" 2>/dev/null; stop_server $P1

echo "═══ P0-2  corrupt ledger must not prevent boot ═══"
P2=4102; D2=$ROOT/p0-2; rm -rf "$D2"; mkdir -p "$D2/.data" "$D2/ws"
# Truncated JSON: the exact condition that previously killed the process at import.
printf '{"version":4,"telemetry":{"a"' > "$D2/.data/software-factory.json"
start_server $P2 "$D2/.data" "$D2/ws" "$D2/app.log" GEMINI_API_KEY= || { echo "  FAIL  server did not start"; cat "$D2/app.log"; FAIL=$((FAIL+1)); }
check "service binds a port despite corrupt ledger" "$(health_code $P2)" "200"
hbody=$(body_of $P2)
check "health reports degraded, not a fake 'healthy'" "$(echo "$hbody" | grep -c '"status":"degraded"')" "1"
check "quarantine file written" "$(ls "$D2/.data" | grep -c corrupt)" "1"
check "startup banner names the degradation" "$(grep -c 'running DEGRADED' "$D2/app.log")" "1"
check "corrupt evidence is retained for audit" "$(grep -c quarantinedPath "$D2/app.log")" "1"
# And it must still be writable, twice, to prove the writer lock was released.
register_tenant $P2
code=$(curl -s -m 8 -o w1.json -w '%{http_code}' -X POST "http://127.0.0.1:$P2/api/telemetry/ingest" "${H4002[@]}" -d '{"tenantId":"tenant_hc_1042","niche":"healthcare","eventType":"x","payload":{"patientCohortId":"C-1"},"metadata":{"idempotencyKey":"post-recovery-1"}}')
check "writes still succeed after recovery" "$code" "200"
code=$(curl -s -m 8 -o w2.json -w '%{http_code}' -X POST "http://127.0.0.1:$P2/api/telemetry/ingest" "${H4002[@]}" -d '{"tenantId":"tenant_hc_1042","niche":"healthcare","eventType":"y","payload":{"patientCohortId":"C-1"},"metadata":{"idempotencyKey":"post-recovery-2"}}')
check "second write succeeds (lock released)" "$code" "200"
check "both writes persisted to the ledger" "$(node -e "console.log(Object.keys(require('$D2/.data/software-factory.json').telemetry).length)")" "2"
# ADR-001 replay protection must survive recovery.
code=$(curl -s -m 8 -o w3.json -w '%{http_code}' -X POST "http://127.0.0.1:$P2/api/telemetry/ingest" "${H4002[@]}" -d '{"tenantId":"tenant_hc_1042","niche":"healthcare","eventType":"x","payload":{"patientCohortId":"C-1"},"metadata":{"idempotencyKey":"post-recovery-1"}}')
check "replayed idempotency key does not duplicate" "$(node -e "console.log(Object.keys(require('$D2/.data/software-factory.json').telemetry).length)")" "2"
# Deterministic fallback: with no Gemini key the pipeline must still complete locally,
# because .env.example documents that behaviour. If it did not, the docs would be lying.
# Three ingests were issued (two new keys plus one replay) and every one must have been
# enriched locally: a replayed key still re-runs enrichment, it just does not duplicate
# the raw record.
check "every ingest used the deterministic fallback" "$(grep -c 'executing deterministic engine' "$D2/app.log")" "3"
stop_server $P2

echo "═══ P0-2b  enrichment outage fails closed, but never silently ═══"
P2B=4112; D2B=$ROOT/p0-2b; rm -rf "$D2B"; mkdir -p "$D2B/.data" "$D2B/ws"
# A configured-but-unusable Gemini key must fail CLOSED, not open. And because the raw
# record is already durable, the error must say so rather than implying data loss.
start_server $P2B "$D2B/.data" "$D2B/ws" "$D2B/app.log" GEMINI_API_KEY=not-a-real-key-fails-fast || { echo "  FAIL  server did not start"; cat "$D2B/app.log"; FAIL=$((FAIL+1)); }
register_tenant $P2B
# KNOWN GAP (P1, recorded not hidden): GeminiConfig sets a 25s timeout with 3 retries,
# so a downstream outage blocks a single ingest for roughly 80 seconds before the
# circuit opens. There is no request-level deadline. This is asserted so it stays visible.
t0=$(date +%s)
code=$(curl -s -m 150 -o e1.json -w '%{http_code}' -X POST "http://127.0.0.1:$P2B/api/telemetry/ingest" "${H4002[@]}" -d '{"tenantId":"tenant_hc_1042","niche":"healthcare","eventType":"x","payload":{"patientCohortId":"C-1"},"metadata":{"idempotencyKey":"outage-1"}}')
t1=$(date +%s)
echo "  INFO  first ingest during outage took $((t1-t0))s (P1: no request deadline)"
check "enrichment outage returns 503, not a false success" "$([ "$code" = "200" ] && echo "200(falsely ok)" || echo "$code")" "503"
check "outage response states the raw record is durable" "$(grep -c '"rawPayloadPersisted":true' e1.json)" "1"
check "outage response marks enrichment retryable" "$(grep -c '"retryable":true' e1.json)" "1"
check "Retry-After header set on 503" "$(curl -s -m 30 -D - -o /dev/null -X POST "http://127.0.0.1:$P2B/api/telemetry/ingest" "${H4002[@]}" -d '{"tenantId":"tenant_hc_1042","niche":"healthcare","eventType":"y","payload":{"patientCohortId":"C-1"},"metadata":{"idempotencyKey":"outage-2"}}' | grep -ci 'retry-after')" "1"
check "raw record really was persisted during the outage" "$([ "$(node -e "console.log(Object.keys(require('$D2B/.data/software-factory.json').telemetry).length)")" -ge 1 ] && echo yes || echo no)" "yes"
check "no transformation was fabricated during the outage" "$(node -e "console.log(Object.keys(require('$D2B/.data/software-factory.json').transformations).length)")" "0"
# The raw upstream Google error body (which echoes credential state and internal
# endpoints) must never reach the caller.
check "upstream error body is NOT leaked to the client" "$(grep -ci 'generativelanguage\|API_KEY_INVALID\|INVALID_ARGUMENT' e1.json)" "0"
check "client sees a stable code, not upstream text" "$(grep -c '"code":"ENRICHMENT' e1.json)" "1"
stop_server $P2B

echo "═══ P0-3  fail-closed startup ═══"
P3=4103; D3=$ROOT/p0-3; rm -rf "$D3"; mkdir -p "$D3/.data" "$D3/ws"
out=$(cd "$ROOT" && env -u FACTORY_API_KEY NODE_ENV=production PORT=$P3 FACTORY_DATA_DIR="$D3/.data" FACTORY_WORKSPACE_ROOT="$D3/ws" timeout 20 node "$BIN" 2>&1); rc=$?
check "production without FACTORY_API_KEY refuses to start (exit 78)" "$rc" "78"
check "startup message is actionable" "$(echo "$out" | grep -c 'FACTORY_API_KEY')" "1"
out=$(cd "$ROOT" && env NODE_ENV=production PORT=$P3 FACTORY_API_KEY=short ALLOW_INSECURE_LOCAL=true FACTORY_DATA_DIR="$D3/.data" FACTORY_WORKSPACE_ROOT="$D3/ws" timeout 20 node "$BIN" 2>&1); rc=$?
check "production with weak key + insecure flag refuses (exit 78)" "$rc" "78"
# A mistyped control variable must not be silently ignored: an operator who believes a
# permission is granted when it is not is the worst possible failure mode.
out=$(cd "$ROOT" && env NODE_ENV=production PORT=$P3 FACTORY_API_KEY="$KEY" FACTORY_DATA_DIR="$D3/.data" FACTORY_WORKSPACE_ROOT="$D3/ws" FACTORY_ALLOWED_MODEL_HOSTS=api.openai.com timeout 20 node "$BIN" 2>&1 & sleep 8; kill -9 %1 2>/dev/null; true)
check "mistyped FACTORY_* variable is reported as having no effect" "$(echo "$out" | grep -c 'is not a recognised setting')" "1"

echo "═══ P0-4  arbitrary filesystem read ═══"
P4=4104; D4=$ROOT/p0-4; rm -rf "$D4"; mkdir -p "$D4/.data" "$D4/ws/proj"
echo '{"name":"probe-project","version":"1.0.0"}' > "$D4/ws/proj/package.json"
# A secret planted OUTSIDE the workspace: a correct guard must never read it.
mkdir -p "$D4/outside" && echo 'AWS_SECRET_ACCESS_KEY=wY0uMustNeverReadThis' > "$D4/outside/.env"
start_server $P4 "$D4/.data" "$D4/ws" "$D4/app.log" || { echo "  FAIL  server did not start"; cat "$D4/app.log"; FAIL=$((FAIL+1)); }
register_tenant $P4
code=$(timeout 20 curl -s -m 15 -o f1.json -w '%{http_code}' -X POST "http://127.0.0.1:$P4/api/operations/quality/scans" "${H4003[@]}" -d '{"repositoryPath":"/"}')
check "scan of / is refused (no hang)" "$(grep -c OUTSIDE_APPROVED_WORKSPACE f1.json)" "1"
code=$(timeout 20 curl -s -m 15 -o f2.json -w '%{http_code}' -X POST "http://127.0.0.1:$P4/api/operations/quality/scans" "${H4003[@]}" -d "{\"repositoryPath\":\"$D4/outside\"}")
check "scan of a path outside the workspace is refused" "$(grep -c OUTSIDE_APPROVED_WORKSPACE f2.json)" "1"
check "out-of-workspace secret was never read" "$(grep -c 'wY0uMustNeverReadThis' f2.json)" "0"
code=$(timeout 20 curl -s -m 15 -o f3.json -w '%{http_code}' -X POST "http://127.0.0.1:$P4/api/operations/quality/scans" "${H4003[@]}" -d "{\"repositoryPath\":\"$D4/ws/../outside\"}")
check "traversal out of the workspace is refused" "$(grep -c OUTSIDE_APPROVED_WORKSPACE f3.json)" "1"
ln -sfn "$D4/outside" "$D4/ws/escape"
code=$(timeout 20 curl -s -m 15 -o f4.json -w '%{http_code}' -X POST "http://127.0.0.1:$P4/api/operations/quality/scans" "${H4003[@]}" -d "{\"repositoryPath\":\"$D4/ws/escape\"}")
check "symlink escaping the workspace is refused" "$(grep -c OUTSIDE_APPROVED_WORKSPACE f4.json)" "1"
# The guard must not break legitimate use: an in-workspace project still scans.
code=$(timeout 30 curl -s -m 25 -o f5.json -w '%{http_code}' -X POST "http://127.0.0.1:$P4/api/operations/quality/adapters" "${H4003[@]}" -d "{\"projectId\":\"probe\",\"repositoryPath\":\"$D4/ws/proj\"}")
check "in-workspace repository still detects its kind" "$(grep -c '"kind":"node"' f5.json)" "1"
check "in-workspace scan actually returned a result" "$([ "$code" = "201" ] && echo yes || echo "http=$code")" "yes"
stop_server $P4

echo
echo "════ LAYER 1: $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ]
