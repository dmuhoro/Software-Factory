#!/usr/bin/env bash
# Fails when credential material is tracked or staged.
#
# ## Why this exists when .gitignore already lists the patterns
#
# Because .gitignore is a convention and this is a control. .gitignore only governs *untracked*
# files, so it does nothing about a file that was committed before the rule was added, and nothing
# at all about a file someone force-added with `git add -f`. This script reads the **index**, which
# is the only place that reflects what a commit would actually contain.
#
# The second reason is more uncomfortable: it also scans the working tree. A secret written into a
# source file is ignored by .gitignore no matter what, because the file is tracked. That is exactly
# how the fabricated Appwrite key in this repository's history got in, and exactly how a real key
# pasted into a test file would get in.
#
# ## What counts as a finding
#
# High-confidence provider token formats only. Each is a distinctive prefix that does not occur in
# ordinary source, so the false-positive rate is low enough that a developer will trust the result
# rather than route around it. A scanner that cries wolf gets disabled, and a disabled scanner is
# worth less than none.
#
# `.env.example` is exempt by design: it must contain placeholder variable names, and placeholders
# are the one thing that must be committed for the file to be useful.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RESET=$'\033[0m'

# Provider token formats. Anchored on distinctive prefixes, not generic assignment shapes, so that
# ordinary code containing the word "token" or "secret" never trips this.
PATTERNS=(
  'standard_[0-9a-f]{32,}'                    # Appwrite server API key
  'AIza[0-9A-Za-z_-]{35}'                     # Google API key
  'AKIA[0-9A-Z]{16}'                         # AWS access key id
  'ASIA[0-9A-Z]{16}'                         # AWS temporary access key id
  'ghp_[0-9A-Za-z]{36}'                      # GitHub personal access token
  'github_pat_[0-9A-Za-z_]{22,}'             # GitHub fine-grained PAT
  'xox[baprs]-[0-9A-Za-z-]{10,}'              # Slack token
  'sk_live_[0-9A-Za-z]{16,}'                 # Stripe live key
  'sk-[0-9A-Za-z]{32,}'                      # OpenAI-style key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'       # PEM private key
  '"type"[[:space:]]*:[[:space:]]*"service_account"'  # GCP service account JSON
)

failures=0
note() { printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"; failures=$((failures + 1)); }

printf '\n%sSecret-exposure gate%s\n' "$YELLOW" "$RESET"

# --- 1. the index: what a commit would actually contain ------------------------------------
printf '  scanning the git index (what a commit would contain)...\n'
index_hits=0
for pattern in "${PATTERNS[@]}"; do
  # `git grep --cached` searches the index, which includes files not yet committed. -I skips
  # binaries; a base64 blob matching a token pattern is not a finding worth blocking on.
  if hits=$(git grep --cached -I -l -E -- "$pattern" -- . 2>/dev/null); then
    hits=$(printf '%s\n' "$hits" | grep -v '^\.env\.example$' | grep -v '^$')
    if [ -n "$hits" ]; then
      note "staged/tracked files match a credential pattern ($pattern):"
      printf '%s\n' "$hits" | sed 's/^/         /'
      index_hits=$((index_hits + 1))
    fi
  fi
done
[ "$index_hits" -eq 0 ] && printf '  %sok%s   no credential material in the index\n' "$GREEN" "$RESET"

# --- 2. the working tree: a secret pasted into a tracked source file ------------------------
printf '  scanning tracked working-tree files for real values in env assignments...\n'
# Matches `NAME=<something that is not obviously a placeholder>`. A variable assigned an empty
# value, a `${...}` reference, or a value containing the words placeholder/example/changeme/xxx
# is documentation, not a secret, and is exactly what .env.example and test fixtures look like.
# A value that is *only* a variable reference -- `FACTORY_API_KEY="$KEY"` in a verification script --
# is likewise not a secret. The first version of this filter missed that and flagged five lines of
# the layer-1 harness, which is precisely how a security gate gets switched off: a control that
# fires on correct code is not a control, it is noise.
# A *literal token* value: 16+ characters of key-shaped material, no shell/JS variable reference
# and no space. This is what makes the filter tractable. `FACTORY_API_KEY="$KEY"` cannot match,
# because `"$KEY"` begins with `$` and a variable is not a secret. Matching on the shape of the
# value rather than on the presence of a credential-shaped name is what keeps this gate usable:
# the first two attempts matched `API_KEY=<anything>` and flagged the layer-1 harness, which is how
# security gates get disabled.
env_hits=$(git ls-files -z '*.ts' '*.js' '*.mjs' '*.cjs' '*.json' '*.md' '*.yaml' '*.yml' '*.sh' 2>/dev/null \
  | xargs -0 grep -InE '(API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_+/=.-]{16,}["'"'"']?' 2>/dev/null \
  | grep -v '\.env\.example' \
  | grep -vE '^(test/|scripts/verify-)' \
  | grep -vEi 'placeholder|example|changeme|your[_-]|redacted|not-a-real|fails-fast|dummy|sample|invalid|process\.env|isPlaceholder|getenv|--[a-z]' || true)
if [ -n "$env_hits" ]; then
  note "tracked files assign a credential-looking value:"
  printf '%s\n' "$env_hits" | head -10 | sed 's/^/         /'
  printf '         (review each; if legitimate, reword so the placeholder is explicit)\n'
else
  printf '  %sok%s   no hardcoded credential values in tracked files\n' "$GREEN" "$RESET"
fi

# --- 3. staged files must not be ignored paths --------------------------------------------
printf '  checking that ignored paths are not staged...\n'
# --no-index is required and its absence was a real bug found by the negative control. Without it
# `git check-ignore` consults the index first, and a file that is staged *is* tracked, so it
# reports "not ignored" for exactly the files this check exists to catch.
staged_ignored=$(git diff --cached --name-only 2>/dev/null | while read -r f; do
  [ -n "$f" ] && git check-ignore --no-index -q "$f" && echo "$f"
done || true)
if [ -n "$staged_ignored" ]; then
  note "these files are ignored but staged (git add -f):"
  printf '%s\n' "$staged_ignored" | sed 's/^/         /'
else
  printf '  %sok%s   no ignored file is staged\n' "$GREEN" "$RESET"
fi

# --- verdict --------------------------------------------------------------------------------
printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '%s════ SECRET GATE: passed ════%s\n\n' "$GREEN" "$RESET"
  exit 0
fi
printf '%s════ SECRET GATE: %d finding(s) ════%s\n' "$RED" "$failures" "$RESET"
printf 'Credential material in the index is a real incident, not a lint finding.\n'
printf 'If a key was ever committed, rotating it is the only fix; removing the file is not enough.\n\n'
exit 1
