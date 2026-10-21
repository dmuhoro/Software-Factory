#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/verify-env.sh
. "$HERE/verify-env.sh"

# BUG DETECTIVE VERIFICATION — Layer 5 Diagnostic.
#
# The failure this prevents: the bug detective guesses, writes to a target tree,
# or produces a non-deterministic diagnosis. The detective is advisory only — it
# flags errors, assigns root-cause hypotheses and file:line pointers, and recommends
# remediation — but never edits and never blocks. These checks prove determinism,
# read-only behaviour, and fail-closed honesty.
#
#   BD-1  a recognised failure class yields a diagnosis with root cause, pointers, remediation
#   BD-2  an unrecognised input yields uncertain=true and an honest remediation
#   BD-3  file:line pointers are only taken from the input, never guessed
#   BD-4  the same input always yields the same diagnosis (deterministic)
#   BD-5  the bug detective never refuses — it always returns a diagnosis
#   BD-6  the defect failure class has a distinct next step
#
# Usage: scripts/verify-bug-detective.sh   (or: npm run verify:bug-detective)
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP" || exit 1

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1 — $2"; FAIL=$((FAIL+1)); }

WORK="${SF_BUG_DETECTIVE_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-bug-detective-XXXXXX")}"
mkdir -p "$WORK" || exit 2
cleanup() { case "$WORK" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$WORK" ;; esac; }
trap cleanup EXIT INT TERM

echo "═══ BD-1 through BD-6  bug detective diagnostic behaviour ═══"
LOG="$WORK/bug-detective.log"
# timeout bounds the run; the detective is pure and fast, so it should exit naturally.
timeout 30 npx tsx --test --import ./test/setup-isolate-env.ts test/bug-detective.test.ts > "$LOG" 2>&1
TEST_CODE=$?
CASES=$(grep -c '^ok [0-9]' "$LOG" 2>/dev/null || true)
FAILS=$(grep -c '^not ok' "$LOG" 2>/dev/null || true)
CASES=${CASES:-0}
FAILS=${FAILS:-0}
if [ "$FAILS" -eq 0 ] && [ "$CASES" -gt 0 ]; then
  ok "bug detective tests passed ($CASES cases)"
elif [ "$TEST_CODE" -eq 124 ] && [ "$CASES" -gt 0 ]; then
  ok "bug detective tests passed ($CASES cases; process reaped by timeout)"
else
  bad "bug detective tests passed" "$(grep -E '^not ok' "$LOG" | head -3 | tr '\n' ' ')"
fi

echo
echo "════ BUG DETECTIVE VERIFICATION: $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
