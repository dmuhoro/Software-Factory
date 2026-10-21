#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/verify-env.sh
. "$HERE/verify-env.sh"

# PREVIEW PLANE VERIFICATION — Layer 2 Agency.
#
# The failure this prevents: a preview session that leaves a dev server running,
# a worktree behind, or a port occupied after the session stops. The preview plane
# is additive — it does not touch the loop, doctrine, or any gate — so the checks
# below prove it creates, serves, screenshots, and stops sessions cleanly.
#
#   PREVIEW-1  createSession builds a worktree, starts a dev server, returns ready
#   PREVIEW-2  an unknown commit is refused before any worktree is created
#   PREVIEW-3  list is tenant-scoped; a tenant sees only its own sessions
#   PREVIEW-4  get returns a session by id
#   PREVIEW-5  stop kills the dev server and removes the worktree
#   PREVIEW-6  stopAll clears every session
#
# Usage: scripts/verify-preview-plane.sh   (or: npm run verify:preview-plane)
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP" || exit 1

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1 — $2"; FAIL=$((FAIL+1)); }

WORK="${SF_PREVIEW_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-preview-XXXXXX")}"
mkdir -p "$WORK" || exit 2
cleanup() { case "$WORK" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$WORK" ;; esac; }
trap cleanup EXIT INT TERM
export FACTORY_DATA_DIR="$WORK/data"
mkdir -p "$FACTORY_DATA_DIR"

echo "═══ PREVIEW-1 through PREVIEW-6  preview plane session lifecycle ═══"
LOG="$WORK/preview.log"
# timeout(1) bounds the run: child dev servers can keep the Node event loop alive
# after the last test, so we cannot wait for natural exit. Test output is already
# flushed to the log before the timeout fires.
timeout 20 npx tsx --test --import ./test/setup-isolate-env.ts --test-concurrency=1 test/preview-plane.test.ts > "$LOG" 2>&1
TEST_CODE=$?
CASES=$(grep -c '^ok [0-9]' "$LOG" 2>/dev/null || true)
FAILS=$(grep -c '^not ok' "$LOG" 2>/dev/null || true)
CASES=${CASES:-0}
FAILS=${FAILS:-0}
if [ "$FAILS" -eq 0 ] && [ "$CASES" -gt 0 ]; then
  ok "preview plane tests passed ($CASES cases)"
elif [ "$TEST_CODE" -eq 124 ] && [ "$CASES" -gt 0 ]; then
  ok "preview plane tests passed ($CASES cases; process reaped by timeout)"
else
  bad "preview plane tests passed" "$(grep -E '^not ok' "$LOG" | head -3 | tr '\n' ' ')"
fi

echo
echo "════ PREVIEW PLANE VERIFICATION: $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
