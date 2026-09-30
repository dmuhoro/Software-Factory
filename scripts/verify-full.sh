#!/usr/bin/env bash
# One command that runs the entire verification chain, in dependency order.
#
# This exists because the honest answer to "is this working?" was spread across nine npm scripts
# with no stated order, and the order matters: a hermetic gate that fails makes the live gates
# meaningless, and a live gate run against a broken build proves nothing. An operator running the
# wrong subset gets a result that looks authoritative and is not.
#
# It loads `.env` so the live layers work without an undocumented `set -a && . ./.env` incantation.
#
# Layers, in order:
#   1  static   lint, types, docs, secrets, workflow definitions, scope split, image references
#   2  tests    the unit and integration suite
#   3  contract the storage contract, exercised on the local backend
#   4  live     Appwrite: reachability, tenant round-trip, storage differential
#
# Layers 1-3 are hermetic: no credential, no network, same result on any machine. Layer 4 runs
# only when Appwrite is configured, and that is a deliberate distinction rather than a courtesy:
#
#   configured and working   -> PASS, with real evidence
#   configured and broken    -> FAIL, and the chain fails with it
#   not configured at all    -> SKIP, because local is a supported deployment mode
#
# `--with-image` adds the Docker image build. It is excluded by default because it takes minutes
# and verifies the *artifact*, not the code: CI already builds it on every push, and a chain that
# takes 30 minutes to say "your tests pass" is a chain people stop running. Every layer has a
# timeout, so a hang is reported as a failure rather than consuming the session.
#
# The middle case is the one that matters. A configured-but-broken integration reported as SKIP
# would be this repository's original sin in a new coat: green output over a system contacting
# nothing. It fails closed.
set -uo pipefail

WITH_IMAGE=no
[ "${1:-}" = "--with-image" ] && WITH_IMAGE=yes

# Per-layer ceiling in seconds. Generous enough for a cold TypeScript compile on a laptop, short
# enough that a stuck network call cannot hold the run open indefinitely.
TIMEOUT="${VERIFY_TIMEOUT:-900}"

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# $'...' rather than '...': a single-quoted \033 is four literal characters, and printf's %s
# does not interpret them. Written the other way, every colour in this script printed as the text
# "\033[31m" -- which is exactly the kind of thing that looks like working output in a log and
# hides that nothing was ever highlighted.
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

FAILED=0
declare -a SUMMARY=()

record() { # name status detail
  local name="$1" status="$2" detail="${3:-}"
  SUMMARY+=("$status"$'\t'"$name"$'\t'"$detail")
  case "$status" in
    PASS) printf '  %sPASS%s  %-34s %s%s%s\n' "$GREEN" "$RESET" "$name" "$DIM" "$detail" "$RESET" ;;
    SKIP) printf '  %sSKIP%s  %-34s %s%s%s\n' "$YELLOW" "$RESET" "$name" "$DIM" "$detail" "$RESET" ;;
    FAIL) printf '  %sFAIL%s  %-34s %s%s%s\n' "$RED" "$RESET" "$name" "$RED" "$detail" "$RESET"; FAILED=$((FAILED + 1)) ;;
  esac
}

run() { # name npm-script -- captures output to a log, records pass/fail
  local name="$1" script="$2" log status
  log="$(mktemp)"
  timeout "$TIMEOUT" npm run --silent "$script" >"$log" 2>&1
  status=$?
  if [ "$status" -eq 124 ]; then
    record "$name" FAIL "exceeded the ${TIMEOUT}s ceiling -- treated as a failure, not a hang"
    printf '\n%s--- %s timed out after %ss ---%s\n' "$DIM" "$name" "$TIMEOUT" "$RESET"
    tail -20 "$log"
  elif [ "$status" -eq 0 ]; then
    record "$name" PASS "$script"
  else
    record "$name" FAIL "$script"
    printf '\n%s--- %s ---%s\n' "$DIM" "$name" "$RESET"
    tail -25 "$log"
    printf '%s%s\n\n' "$DIM" "$RESET"
  fi
  rm -f "$log"
}

printf '\n%sSOFTWARE FACTORY -- full verification%s\n' "$BOLD" "$RESET"
printf '%sone command, in dependency order. live layer runs only if Appwrite is configured.%s\n\n' "$DIM" "$RESET"

printf '%sLayer 1 -- static%s\n' "$BOLD" "$RESET"
run "typecheck"            "lint"
run "documentation"        "verify:docs"
run "no committed secrets" "verify:secrets"
run "workflow definitions" "verify:integrations"
run "appwrite scope split" "verify:scopes"

if [ "$WITH_IMAGE" = "yes" ]; then
  run "container image" "verify:image"
else
  record "container image" SKIP "not built by default; re-run with --with-image (CI builds it every push)"
fi

printf '\n%sLayer 2 -- tests%s\n' "$BOLD" "$RESET"
run "unit and integration" "test"

printf '\n%sLayer 3 -- storage contract (local, hermetic)%s\n' "$BOLD" "$RESET"
run "local storage parity" "verify:storage"

printf '\n%sLayer 4 -- live Appwrite%s\n' "$BOLD" "$RESET"

CONFIGURED=no
for v in APPWRITE_ENDPOINT APPWRITE_PROJECT_ID APPWRITE_API_KEY; do
  [ -n "${!v:-}" ] || CONFIGURED="no ($v unset)"
done
[ "$CONFIGURED" = "no" ] && CONFIGURED=yes

if [ "$CONFIGURED" != "yes" ]; then
  record "appwrite configured" SKIP "$CONFIGURED -- running on the local durable store"
  record "appwrite reachability" SKIP "not attempted"
  record "tenant round-trip" SKIP "not attempted"
  record "storage differential" SKIP "not attempted"
else
  record "appwrite configured" PASS "endpoint, project and key all set"

  CHECK_LOG="$(mktemp)"
  timeout 180 npm run --silent appwrite:check >"$CHECK_LOG" 2>&1
  if [ $? -eq 0 ]; then
    record "appwrite reachability" PASS "authenticated probe succeeded"
  else
    record "appwrite reachability" FAIL "Appwrite refused or could not be reached"
    printf '\n%s--- appwrite reachability ---%s\n' "$DIM" "$RESET"
    grep -vE '^\s*$' "$CHECK_LOG" | tail -30
    printf '%s\n\n' "$RESET"
    record "tenant round-trip" SKIP "skipped: reachability failed, so the result would be noise"
    record "storage differential" SKIP "skipped: reachability failed, so the result would be noise"
  fi
  rm -f "$CHECK_LOG"

  if grep -q "appwrite reachability.*PASS" <<<"$(printf '%s\n' "${SUMMARY[@]}")"; then
    run "tenant round-trip"       "appwrite:e2e"
    run "storage differential"    "verify:storage:live"
  fi
fi

printf '\n%sSUMMARY%s\n' "$BOLD" "$RESET"
printf '%s\n' "${SUMMARY[@]}" | awk -F'\t' '
  { if ($1 != last) { printf "\n  "; last = $1 } printf "%s%s%s  ", ($1=="PASS"?"\033[32m":$1=="SKIP"?"\033[33m":"\033[31m"), $2, "\033[0m" }
  END { print "" }'

TOTAL=${#SUMMARY[@]}
printf '\n  %s%d checks, %s%d failed%s\n' "$DIM" "$TOTAL" "$RED" "$FAILED" "$RESET"

if [ "$FAILED" -gt 0 ]; then
  printf '\n%sVERIFICATION FAILED%s -- %s%d of %d check(s) failed. [pid %s]\n\n' "$RED" "$RESET" "$RED" "$FAILED" "$TOTAL" "$$"
  exit 1
fi

printf '\n%sVERIFICATION PASSED%s -- %s%s\n' "$GREEN" "$RESET" "$DIM" "$TOTAL checks green" "$RESET"
printf '%sThis proves the code behaves as specified against the configured backends.%s' "$DIM" "$RESET"
printf '%sIt does not prove production readiness: see docs/OPERATIONS.md for what remains.%s\n\n' "$DIM" "$RESET"
exit 0
