#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Ambient shell config must not decide whether a loop check passes. See scripts/verify-env.sh.
# shellcheck source=scripts/verify-env.sh
. "$HERE/verify-env.sh"

# UNATTENDED LOOP VERIFICATION — doctrine → gate wiring, the driver, and the CLI contract.
#
# The failure this prevents: a hook id in doctrine/hooks.json that no code implements. A stage
# then reports itself guarded while nothing runs, and every claim downstream — verified commit,
# attempt cap, secret refusal, one-commit-per-unit — inherits a hole nobody can see from the
# documentation. The checks below are the ones a reader can run by name:
#
#   LOOP-1  the rulebook on disk is the rulebook that was reviewed (manifest)
#   LOOP-2  every gate doctrine names has an implementation, and vice versa
#   LOOP-3  the driver commits verified work, refuses a secret, and gives up on a unit at the cap
#   LOOP-4  the CLI exits with the code it documents
#
# Usage: scripts/verify-loop.sh   (or: npm run verify:loop)
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP" || exit 1

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1 — $2"; FAIL=$((FAIL+1)); }

WORK="${SF_LOOP_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/sf-loop-XXXXXX")}"
mkdir -p "$WORK" || exit 2
cleanup() { case "$WORK" in /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$WORK" ;; esac; }
trap cleanup EXIT INT TERM
export FACTORY_DATA_DIR="$WORK/data"
mkdir -p "$FACTORY_DATA_DIR"

echo "═══ LOOP-1  the doctrine manifest matches the files on disk ═══"
MANIFEST_OUT="$(npx tsx scripts/doctrine-manifest.ts --check 2>&1)"
if [ $? -eq 0 ]; then
  ok "doctrine manifest verified"
else
  bad "doctrine manifest verified" "$(echo "$MANIFEST_OUT" | tr '\n' ' ' | cut -c1-160)"
fi

echo "═══ LOOP-2  every gate doctrine names is implemented, and vice versa ═══"
if npx tsx --test --import ./test/setup-isolate-env.ts --test-concurrency=1 test/loop-doctrine.test.ts > "$WORK/doctrine.log" 2>&1; then
  ok "doctrine tests passed ($(grep -c '^ok [0-9]' "$WORK/doctrine.log") cases, including registry coverage)"
else
  bad "doctrine tests passed" "$(grep -E '^not ok' "$WORK/doctrine.log" | head -3 | tr '\n' ' ')"
fi

echo "═══ LOOP-3  the driver runs plan → implement → verify → commit → report ═══"
if npx tsx --test --import ./test/setup-isolate-env.ts --test-concurrency=1 test/loop-execution.test.ts > "$WORK/execution.log" 2>&1; then
  ok "end-to-end loop runs passed ($(grep -c '^ok [0-9]' "$WORK/execution.log") scenarios)"
else
  bad "end-to-end loop runs passed" "$(grep -E '^not ok' "$WORK/execution.log" | head -3 | tr '\n' ' ')"
fi

echo "═══ LOOP-4  the CLI exits with the code it documents ═══"
CLI="npx tsx scripts/run-factory-loop.ts"

$CLI --help > "$WORK/help.txt" 2>&1
if [ $? -eq 0 ] && grep -q "Exit codes: 0 all committed" "$WORK/help.txt"; then
  ok "--help exits 0 and prints the exit-code contract"
else
  bad "--help exits 0 and prints the exit-code contract" "exit $?"
fi

$CLI > "$WORK/none.txt" 2>&1
code=$?
if [ "$code" -eq 1 ]; then ok "no arguments exits 1 (refused to start)"; else bad "no arguments exits 1" "exit $code"; fi

$CLI --bogus > "$WORK/bogus.txt" 2>&1
code=$?
if [ "$code" -eq 1 ] && grep -q "FLAG_UNKNOWN" "$WORK/bogus.txt"; then
  ok "an unknown flag exits 1 and names the flag"
else
  bad "an unknown flag exits 1 and names the flag" "exit $code"
fi

$CLI --repo "$WORK/nowhere" --task "$WORK/nowhere.md" > "$WORK/missing.txt" 2>&1
code=$?
if [ "$code" -eq 1 ] && grep -q "PATH_MISSING" "$WORK/missing.txt"; then
  ok "a missing path exits 1 rather than starting"
else
  bad "a missing path exits 1 rather than starting" "exit $code"
fi

echo
echo "════ LOOP VERIFICATION: $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
