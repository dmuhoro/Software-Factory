#!/usr/bin/env bash
# Negative control for scripts/verify-no-secrets.sh.
#
# ## Why this file exists
#
# A security gate that has never rejected anything is an assumption, not a control. This script
# plants known-bad secrets, proves the gate rejects each one, and cleans up after itself. It is the
# evidence that `verify-no-secrets.sh` is a gate and not decoration.
#
# ## It has already earned its place
#
# On its first run it caught three defects in the gate that reading the gate did not:
#
#   1. `git grep` parsed the PEM pattern as a command-line option, because the pattern begins with
#      `-`. A private key in the repository was invisible to the scanner. Fixed with `--`.
#   2. `git check-ignore` consults the index, and a staged file *is* tracked, so the "ignored file
#      was force-added" check reported every file as not-ignored -- i.e. it could never fail.
#      Fixed with `--no-index`.
#   3. A test in this very file used the variable name `KEY`, which the gate correctly does not
#      match, and a `sed` that silently did not apply hid that for one more run.
#
# The third is the same class of error as a `str.replace` that does not match and reports success.
# A test that cannot fail is worse than no test, because it manufactures confidence.
#
# ## Cleanup
#
# Everything it creates is removed and unstaged, including on failure, so it can be run against a
# dirty tree without leaving landmines behind.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

GATE="bash scripts/verify-no-secrets.sh"
REJECTED=0
MISSED=0
CREATED=()

cleanup() {
  for f in "${CREATED[@]:-}"; do
    [ -n "$f" ] || continue
    git rm -q --cached "$f" >/dev/null 2>&1
    rm -f "$f"
  done
}
trap cleanup EXIT

expect_reject() {
  local label="$1" file="$2"
  if $GATE >/dev/null 2>&1; then
    printf '  %sFAIL%s  gate did NOT reject: %s\n' "$(printf '\033[0;31m')" "$(printf '\033[0m')" "$label"
    MISSED=$((MISSED + 1))
  else
    printf '  %sok%s    gate rejected: %s\n' "$(printf '\033[0;32m')" "$(printf '\033[0m')" "$label"
    REJECTED=$((REJECTED + 1))
  fi
  git rm -q --cached "$file" >/dev/null 2>&1
  rm -f "$file"
  CREATED=()
}

plant() {
  local file="$1"
  git add -f "$file" >/dev/null 2>&1
  CREATED+=("$file")
}

printf '\n%sNegative control: proving the secret gate rejects real secrets%s\n' \
  "$(printf '\033[0;33m')" "$(printf '\033[0m')"

# --- tier 1: real provider token formats, no path exemptions -------------------------------
# Planted inside test/ on purpose. Tier 2 exempts the test harness, so this only passes if tier 1
# is genuinely independent of path. If someone later exempts tier 1 as well, this fails.

# --- how the planted secrets are built -------------------------------------------------------
#
# Note what is NOT here: no credential-shaped string literal. Each one is assembled at runtime from
# fragments, so this file contains nothing the gate could match.
#
# The first version hardcoded them and the secret gate correctly failed on the gate's own control
# script. The tempting fix was to exempt `scripts/verify-secret-gate-control.sh` the way `test/` is
# exempted, and that would have been wrong twice over: an exemption list in a security control is
# exactly the thing that erodes, and it would have meant the one file whose job is to verify the
# gate is itself unverifiable. Assembling the strings keeps the gate honest with no special cases.
#
# A useful side effect: the gate is now proven against genuinely generated strings rather than
# against fixtures someone typed to match the pattern.

# Brace expansion, not `$(seq)`. `printf 'ab%.0s' "$(seq 1 64)"` passes the whole sequence as ONE
# argument, so the format is applied once and the result is the two characters "ab" -- which made
# both of these generators emit a 5-to-11 character string that matched no pattern, and the control
# reported the gate as broken when the gate was fine. The failure looked like a security defect and
# was a quoting bug in a test.
secret_appwrite() { printf '%s%s' 'standard_' "$(printf 'ab%.0s' {1..64})"; }
secret_aws()      { printf '%s%s' 'AKIA'     'IOSFODNN7EXAMPLE'; }
secret_github()   { printf '%s%s' 'ghp_'     "$(printf 'a%.0s' {1..36})"; }
secret_literal()  { printf 'q7Zm2Xr9Tv4Lp8Kd3Nhw6Yb1Sf5Cg0Je'; }
secret_pem_head() { printf '%s %s' '-----BEGIN RSA' 'PRIVATE KEY-----'; }

# --- tier 1: real provider token formats, no path exemptions -------------------------------
# Planted inside test/ on purpose. Tier 2 exempts the test harness, so this only passes if tier 1
# is genuinely independent of path. If someone later exempts tier 1 as well, this fails.

printf 'export const injected = "%s";\n' "$(secret_appwrite)" > test/__negctl_appwrite.ts
plant test/__negctl_appwrite.ts
expect_reject 'Appwrite server key inside test/ (tier 1 ignores the tier-2 test exemption)' test/__negctl_appwrite.ts

printf 'export const injected = "%s";\n' "$(secret_aws)" > src/__negctl_aws.ts
plant src/__negctl_aws.ts
expect_reject 'AWS access key id in src/' src/__negctl_aws.ts

# The pattern begins with a hyphen. Without `--` this is parsed as a git grep option and a private
# key in the repository is invisible to the scanner. That was a real defect, caught here.
printf '%s\nMIIEpAIBAAKCAQEAx7Zq\n' "$(secret_pem_head)" > src/__negctl_pem.pem
plant src/__negctl_pem.pem
expect_reject 'PEM private key in src/ (pattern begins with a hyphen)' src/__negctl_pem.pem

printf 'export const injected = "%s";\n' "$(secret_github)" > src/__negctl_ghp.ts
plant src/__negctl_ghp.ts
expect_reject 'GitHub personal access token in src/' src/__negctl_ghp.ts

# --- tier 2: hardcoded credential value, heuristic shape -----------------------------------
# A real Appwrite/Gemini key reworded so it carries no recognisable provider prefix. This is the
# case a prefix list cannot see, and the reason tier 2 exists at all.

printf 'export const APPWRITE_API_KEY = "%s";\n' "$(secret_literal)" > src/__negctl_literal.ts
plant src/__negctl_literal.ts
expect_reject 'hardcoded credential value with no provider prefix in src/' src/__negctl_literal.ts

# --- tier 3: an ignored path that was force-staged ------------------------------------------

printf 'APPWRITE_API_KEY=%s\n' "$(secret_literal)" > .env.negctl
plant .env.negctl
expect_reject 'ignored .env file force-staged with git add -f' .env.negctl

# --- verdict ---------------------------------------------------------------------------------
printf '\n'
if [ "$MISSED" -eq 0 ]; then
  printf '%s════ SECRET GATE CONTROL: %d/%d planted secrets correctly rejected ════%s\n\n' \
    "$(printf '\033[0;32m')" "$REJECTED" "$REJECTED" "$(printf '\033[0m')"
  exit 0
fi
printf '%s════ SECRET GATE CONTROL: %d rejected, %d MISSED ════%s\n' \
  "$(printf '\033[0;31m')" "$REJECTED" "$MISSED" "$(printf '\033[0m')"
printf 'A gate that does not reject these is not a gate. Fix the gate, not the test.\n\n'
exit 1
