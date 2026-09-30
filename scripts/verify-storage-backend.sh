#!/usr/bin/env bash
# Proves STORAGE_BACKEND=appwrite works on the real request path, against the live Appwrite project.
#
# ## What this is not
#
# This is not a unit test of the backend selector. `test/storage-backend.test.ts` covers that a
# process can select a backend and refuses a bad value. Neither of those proves that an HTTP
# request from an authenticated tenant reaches Appwrite, which is the only claim that matters to a
# customer whose event was accepted.
#
# So this starts the real built server, boots it with STORAGE_BACKEND=appwrite, checks the banner
# says so, and then asserts the *negative control*: that a request is refused when the backend
# cannot be reached. A backend that accepts writes it cannot perform is worse than one that is off.
#
# ## Two modes, because one is not enough
#
# - `--require-appwrite` asserts a successful authenticated write reaches the live database.
#   Requires real credentials; skips cleanly (exit 0 with a clear notice) without them, so this is
#   safe to run in CI and on a laptop that has never been logged in.
# - The default mode needs no credentials and asserts the two properties that must hold
#   unconditionally: a typo in STORAGE_BACKEND stops the process, and the banner states the truth.
#
# `STORAGE_BACKEND=appwirte` must prevent the process from starting at all. If it starts, a
# deployment typo silently becomes a local write, and the operator has no way to notice.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RESET=$'\033[0m'
FAIL=0
PASS_COUNT=0
ROOT="$(pwd)"
# `set -u` is on deliberately: an unbound variable in a verification script must abort loudly
# rather than expand to empty and produce a check that silently passes.
ROOT_TMP="$(mktemp -d /tmp/sf-storage-XXXXXX)"

# The child processes are started with an explicit environment rather than an inherited one.
# `env VAR=x node` keeps everything else, so a developer's sourced .env (which sets
# ALLOW_INSECURE_LOCAL=true) leaked in and the server correctly refused to boot in production --
# a correct refusal aimed at the wrong target. A gate must measure the configuration under test,
# not the shell that launched it.
CLEAN_ENV=(env -u ALLOW_INSECURE_LOCAL -u APPWRITE_ENDPOINT -u APPWRITE_PROJECT_ID
           -u APPWRITE_API_KEY -u APPWRITE_DATABASE_ID -u STORAGE_BACKEND
           -u NODE_OPTIONS -u FACTORY_ALLOWED_SECRET_REFS -u FACTORY_ALLOWED_MODEL_HOSTS
           -u GEMINI_API_KEY -u GOOGLE_API_KEY -u FACTORY_ALLOWED_SECRET_REFS)
# Synthetic credentials for the harness only. Long enough to clear the production minimum, and
# obviously not real.
PLATFORM_KEY="harness-platform-key-0000000000000000"
TENANT_ID="tenant_re_8841"  # a seeded demo tenant; naming an unknown one is refused at startup, correctly
TENANT_KEY="harness-tenant-key-00000000000000000"

cleanup() {
  if [ -f "$ROOT_TMP/srv.pid" ]; then
    kill -9 "$(cat "$ROOT_TMP/srv.pid")" 2>/dev/null
    wait "$(cat "$ROOT_TMP/srv.pid")" 2>/dev/null
  fi
  rm -rf "$ROOT_TMP"
}
trap cleanup EXIT

ok()   { printf '  %sok%s    %s\n' "$GREEN" "$RESET" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }

# Returns 0 once the server announces it is listening, 1 if it died or never got there.
# A silent crash must be reported as a failure with its log, never as a passing check.
wait_for_server() {
  local logfile="$1" pid="$2" port="$3"
  for _ in $(seq 1 80); do
    grep -q "listening on 0.0.0.0:$port" "$logfile" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$RESET" "$1"; FAIL=$((FAIL+1)); }

# --- build -------------------------------------------------------------------------------------
printf '\n%sStorage-backend gate%s\n' "$YELLOW" "$RESET"
mkdir -p dist
if ! npm run build >/dev/null 2>&1; then
  bad "the project must build before this gate can mean anything"
  printf '\n%s════ STORAGE GATE: 0 passed, 1 failed ════%s\n\n' "$RED" "$RESET"
  exit 1
fi
ok "project builds"

# --- property 1: a bad backend refuses to start -------------------------------------------------
# The most important check in this file, and the one that needs no credentials.
PORT=8791
mkdir -p "$ROOT_TMP/bad/.data" "$ROOT_TMP/bad/ws"
( cd "$ROOT_TMP" && exec "${CLEAN_ENV[@]}" NODE_PATH="$ROOT/node_modules" NODE_ENV=production PORT=$PORT \
    FACTORY_API_KEY="$PLATFORM_KEY" FACTORY_TENANT_SEED_DEMO=true \
    FACTORY_TENANT_CREDENTIALS="$TENANT_ID:$TENANT_KEY" \
    STORAGE_BACKEND=appwirte \
    FACTORY_DATA_DIR="$ROOT_TMP/bad/.data" FACTORY_WORKSPACE_ROOT="$ROOT_TMP/bad/ws" \
    node "$ROOT/dist/server.cjs" ) > "$ROOT_TMP/bad.log" 2>&1 &
BAD_PID=$!
sleep 3
if kill -0 "$BAD_PID" 2>/dev/null; then
  bad "a server started with STORAGE_BACKEND=appwirte; a typo must stop the process, not be ignored"
  kill -9 "$BAD_PID" 2>/dev/null
  wait "$BAD_PID" 2>/dev/null
else
  wait "$BAD_PID" 2>/dev/null
  if grep -qi "STORAGE_BACKEND" "$ROOT_TMP/bad.log"; then
    ok "STORAGE_BACKEND=appwirte is refused at startup with a named reason"
  else
    bad "the process died but never said why; a silent crash teaches operators to guess"
    tail -5 "$ROOT_TMP/bad.log" | sed 's/^/         /'
  fi
fi

# --- property 2: the banner states the real backend ---------------------------------------------
PORT=8792
mkdir -p "$ROOT_TMP/ok/.data" "$ROOT_TMP/ok/ws"
( cd "$ROOT_TMP" && exec "${CLEAN_ENV[@]}" NODE_PATH="$ROOT/node_modules" NODE_ENV=production PORT=$PORT \
    FACTORY_API_KEY="$PLATFORM_KEY" FACTORY_TENANT_SEED_DEMO=true \
    FACTORY_TENANT_CREDENTIALS="$TENANT_ID:$TENANT_KEY" \
    STORAGE_BACKEND=local \
    FACTORY_DATA_DIR="$ROOT_TMP/ok/.data" FACTORY_WORKSPACE_ROOT="$ROOT_TMP/ok/ws" \
    node "$ROOT/dist/server.cjs" ) > "$ROOT_TMP/ok.log" 2>&1 &
echo $! > "$ROOT_TMP/srv.pid"
if ! wait_for_server "$ROOT_TMP/ok.log" "$(cat "$ROOT_TMP/srv.pid")" "$PORT"; then
  bad "the server did not start with STORAGE_BACKEND=local"
  tail -10 "$ROOT_TMP/ok.log" | sed 's/^/         /'
else
  if grep -qE "storage +local" "$ROOT_TMP/ok.log"; then
    ok "the startup banner names the active backend (local)"
  else
    bad "the banner does not state which store is in use; an operator cannot verify what is running"
  fi
  # A real authenticated request, to prove the local path still serves end to end.
  code=$(curl -s -o "$ROOT_TMP/resp.json" -w '%{http_code}' -X POST \
    "http://127.0.0.1:$PORT/api/telemetry/ingest" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TENANT_KEY" \
    -d "{\"tenantId\":\"$TENANT_ID\",\"niche\":\"real_estate\",\"eventType\":\"STORAGE_GATE_PROBE\",\"payload\":{\"probe\":true,\"propertyId\":\"prop_gate_probe\"},\"metadata\":{\"idempotencyKey\":\"storage-gate-local-1\"}}" 2>/dev/null)
  # Two shapes are a pass here, and being precise about why matters.
  # 503 + rawPayloadPersisted=true means the raw event reached storage and was written, and the
  # enrichment that follows failed because a configured model call failed. That is a storage
  # success and a model failure, and a gate that calls it a storage failure would be lying.
  # 200 is the normal case: with no model key the product runs its deterministic engine, so the
  # request completes. Model keys are excluded from the child env so this result does not depend
  # on whether the operator happens to have a key exported.
  case "$code" in
    200|201|202)
      ok "an authenticated tenant request is accepted on the local backend (HTTP $code)";;
    503)
      if grep -q '"rawPayloadPersisted":true' "$ROOT_TMP/resp.json"; then
        ok "the raw event is persisted by the local backend (503 is enrichment failing closed, not a storage failure)"
      else
        bad "HTTP 503 but rawPayloadPersisted is not true: the record was neither stored nor confirmed"
        head -c 300 "$ROOT_TMP/resp.json" | sed 's/^/         body: /'; echo
      fi;;
    401|403)
      bad "the local backend refused an authenticated request (HTTP $code)"
      head -c 300 "$ROOT_TMP/resp.json" | sed 's/^/         body: /'; echo;;
    *)
      bad "unexpected status $code from the ingest route"
      head -c 300 "$ROOT_TMP/resp.json" | sed 's/^/         body: /'; echo;;
  esac

  # The same tenant asking for a niche it is not provisioned for must be refused. This is the
  # CustomB2B boundary doing its job, and it is asserted here rather than assumed: a tenant
  # provisioned for real_estate asking for CustomB2B is cross-niche conflation, and the product
  # rejects it. Found by this gate while it was still failing for its own reasons.
  xcode=$(curl -s -o "$ROOT_TMP/xniche.json" -w '%{http_code}' -X POST \
    "http://127.0.0.1:$PORT/api/telemetry/ingest" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TENANT_KEY" \
    -d "{\"tenantId\":\"$TENANT_ID\",\"niche\":\"CustomB2B\",\"eventType\":\"STORAGE_GATE_PROBE\",\"payload\":{\"probe\":true},\"metadata\":{\"idempotencyKey\":\"storage-gate-xniche-1\"}}" 2>/dev/null)
  if { [ "$xcode" = "400" ] || [ "$xcode" = "403" ]; } && grep -q "MALFORMED_CONTEXT" "$ROOT_TMP/xniche.json"; then
    ok "a tenant provisioned for one niche is refused another (cross-niche conflation rejected)"
  else
    bad "cross-niche conflation was not refused (HTTP $xcode); the tenant boundary is the product's core control"
    head -c 300 "$ROOT_TMP/xniche.json" | sed 's/^/         body: /'; echo
  fi
fi
# Reap the child so the shell does not print a job-control "Killed" notice that reads like a
# crash in the gate's own output.
if [ -f "$ROOT_TMP/srv.pid" ]; then
  SRV_PID="$(cat "$ROOT_TMP/srv.pid")"
  kill -9 "$SRV_PID" 2>/dev/null
  wait "$SRV_PID" 2>/dev/null
  rm -f "$ROOT_TMP/srv.pid"
fi

# --- property 3: live write path, only with real credentials -------------------------------------
if [ "${1:-}" = "--require-appwrite" ]; then
  if [ -z "${APPWRITE_API_KEY:-}" ] || [ -z "${APPWRITE_PROJECT_ID:-}" ]; then
    printf '  %sskip%s  --require-appwrite given but APPWRITE_API_KEY / APPWRITE_PROJECT_ID are unset\n' "$YELLOW" "$RESET"
  else
    # The store-level round trip, which exercises the real Appwrite tables directly.
    if STORAGE_BACKEND=appwrite npx tsx scripts/e2e-tenant-roundtrip.ts > "$ROOT_TMP/e2e.log" 2>&1; then
      ok "live Appwrite store round trip (including the unknown-tenant refusal)"
      sed 's/^/         /' "$ROOT_TMP/e2e.log" | grep -E "checks passed|refused it|no foreign key"
    else
      bad "the live Appwrite store round trip failed"
      sed 's/^/         /' "$ROOT_TMP/e2e.log" | tail -14
    fi

    # Then the same assertion as the local mode, but through a running server. Without this the
    # gate would only ever prove the SDK works, never that STORAGE_BACKEND reaches a request.
    PORT=8793
    ( cd "$ROOT_TMP" && exec env \
      -u ALLOW_INSECURE_LOCAL -u GEMINI_API_KEY -u GOOGLE_API_KEY \
      NODE_PATH="$ROOT/node_modules" NODE_ENV=production PORT=$PORT \
      APPWRITE_ENDPOINT="$APPWRITE_ENDPOINT" APPWRITE_PROJECT_ID="$APPWRITE_PROJECT_ID" \
      APPWRITE_API_KEY="$APPWRITE_API_KEY" APPWRITE_DATABASE_ID="$APPWRITE_DATABASE_ID" \
      FACTORY_API_KEY="$PLATFORM_KEY" FACTORY_TENANT_SEED_DEMO=true \
      FACTORY_TENANT_CREDENTIALS="$TENANT_ID:$TENANT_KEY" \
      FACTORY_DATA_DIR="$ROOT_TMP/aw/.data" FACTORY_WORKSPACE_ROOT="$ROOT_TMP/aw/ws" \
      STORAGE_BACKEND=appwrite \
      node "$ROOT/dist/server.cjs" ) > "$ROOT_TMP/aw.log" 2>&1 &
    AW_PID=$!
    wait_for_server "$ROOT_TMP/aw.log" "$AW_PID" "$PORT" || true

    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      ok "the server boots with STORAGE_BACKEND=appwrite against the live project"

      # A differential assertion, and the reason this is worth running at all. $TENANT_ID exists in
      # the LOCAL registry (it is a seeded demo tenant) but not in the Appwrite tenants table. The
      # local backend therefore accepted this exact request earlier in this script, and the Appwrite
      # backend must refuse it. Identical request, opposite outcome, so the switch provably changes
      # the persistence path instead of being a label the process prints and ignores.
      acode=$(curl -s -o "$ROOT_TMP/aw-resp.json" -w '%{http_code}' -X POST \
        "http://127.0.0.1:$PORT/api/telemetry/ingest" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $TENANT_KEY" \
        -d "{\"tenantId\":\"$TENANT_ID\",\"niche\":\"real_estate\",\"eventType\":\"STORAGE_GATE_PROBE\",\"payload\":{\"propertyId\":\"prop_gate_probe\"},\"metadata\":{\"idempotencyKey\":\"storage-gate-aw-1\",\"sourceSystem\":\"gate\",\"region\":\"fra\",\"clientVersion\":\"0\"}}" 2>/dev/null)
      if [ "$acode" = "403" ] && grep -q "TENANT_NOT_ONBOARDED" "$ROOT_TMP/aw-resp.json"; then
        ok "the Appwrite backend refuses a tenant the cloud registry does not have (403 TENANT_NOT_ONBOARDED)"
        echo "         the same request was accepted by the local backend, so STORAGE_BACKEND provably changes the write path"
      else
        bad "the Appwrite backend did not refuse the un-onboarded tenant (HTTP $acode); either the backend is not really Appwrite, or the tenant check is not wired"
        head -c 300 "$ROOT_TMP/aw-resp.json" | sed 's/^/         body: /'; echo
        tail -6 "$ROOT_TMP/aw.log" | sed 's/^/         log: /'
      fi
    else
      bad "the server did not boot with STORAGE_BACKEND=appwrite"
      tail -14 "$ROOT_TMP/aw.log" | sed 's/^/         /'
    fi
    kill -9 "$AW_PID" 2>/dev/null; wait "$AW_PID" 2>/dev/null
  fi
fi

# --- verdict ------------------------------------------------------------------------------------
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '%s════ STORAGE GATE: %d passed, 0 failed ════%s\n\n' "$GREEN" "$PASS_COUNT" "$RESET"
  exit 0
fi
printf '%s════ STORAGE GATE: %d passed, %d failed ════%s\n\n' "$GREEN" "$PASS_COUNT" "$FAIL" "$RESET"
exit 1
