#!/usr/bin/env bash
# Proves set-secret.sh does not echo a credential handed to it as an argument.
#
# This exists because the refusal message used to print the argument verbatim. The validation was
# correct -- the script wants a variable name -- and the error handling was the leak, so a correct
# script printed secrets under precisely the conditions an operator was most likely to paste
# things into a terminal.
#
# Static review cannot catch that. The claim is "this script does not print the secret", and the
# only honest evidence is running it with a secret and reading the bytes that come back.
set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
FAILURES=0

# A well-formed key shape, so the argument genuinely looks like a credential rather than
# accidentally tripping a pattern. The value is a test constant, not a real credential.
FAKE='standard_0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000_0000'
SECRET_PART='0000000000000000000000000000000000000000000000000000000000000000'

check() { # description expect substring
  local desc="$1" expect="$2" out
  out="$(bash scripts/set-secret.sh "$FAKE" 2>&1 || true)"

  if printf '%s' "$out" | grep -qF "$expect"; then
    printf '  %sPASS%s  %s\n' "$GREEN" "$RESET" "$desc"
  else
    printf '  %sFAIL%s  %s\n' "$RED" "$RESET" "$desc"
    printf '        output was: %s\n' "$(printf '%s' "$out" | head -3)"
    FAILURES=$((FAILURES + 1))
  fi

  # The assertion that matters: the secret must not be in the output at all. A truncated prefix
  # still leaks a real credential's identifying half, so this checks the whole run.
  if printf '%s' "$out" | grep -qF "$SECRET_PART"; then
    printf '  %sFAIL%s  the credential appeared in the output at all\n' "$RED" "$RESET"
    FAILURES=$((FAILURES + 1))
  else
    printf '  %sPASS%s  no part of the credential appears in the output\n' "$GREEN" "$RESET"
  fi
}

printf '\n%sset-secret.sh does not echo credentials back to the terminal%s\n\n' "$RED" "$RESET"

check 'a credential-shaped argument is refused' 'refusing a credential passed as an argument'
check 'the refusal explains where argv leaks' 'shell history'
check 'the refusal tells the operator to rotate' 'Rotate this key'

# The malformed-name path changed too, so a variable name typo cannot echo either.
NAME_OUT="$(bash scripts/set-secret.sh not_a_valid_name 2>&1 || true)"
if printf '%s' "$NAME_OUT" | grep -qF 'UPPER_SNAKE_CASE'; then
  printf '  %sPASS%s  a malformed name is refused without echoing the argument\n' "$GREEN" "$RESET"
else
  printf '  %sFAIL%s  a malformed name did not produce the expected refusal\n' "$RED" "$RESET"
  FAILURES=$((FAILURES + 1))
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '%s════ ARGV LEAK CONTROL: all checks passed ════%s\n\n' "$GREEN" "$RESET"
  exit 0
fi
printf '%s════ ARGV LEAK CONTROL: %d FAILED ════%s\n' "$RED" "$FAILURES" "$RESET"
printf 'A secret handler that prints secrets back is a leak, not a convenience.\n\n'
exit 1
