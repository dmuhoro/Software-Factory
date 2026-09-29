#!/usr/bin/env bash
#
# Assert that every command an operator is told to run actually exists.
#
# The failure this prevents already happened. `docs/FOUNDER_OPERATING_PLAYBOOK.md` told the
# founder to run `bun install --frozen-lockfile` after `bun.lock` had been deleted in 7af6238
# and npm had become the canonical package manager. `bun install --frozen-lockfile` with no
# `bun.lock` present fails outright, so the documented startup procedure for this product was
# broken, in the document whose entire purpose is the startup procedure. It survived because
# nothing read the document to check that its commands exist.
#
# The scope is deliberately narrow: markdown under docs/ and sprints/, plus the package
# scripts. This is not a documentation linter. It extracts the commands a human is instructed
# to run and asks whether they resolve. Prose correctness is a human's job; a command that
# cannot run is a mechanical defect and belongs to a gate.
#
# Usage: scripts/verify-docs.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

section "No document instructs a package manager this repository does not use"
# npm is canonical per ADR-007. A `bun` command in an operational document is a defect, not a
# historical note -- and the distinction matters, so records under sprints/ and the ADRs are
# excluded: they are dated history of what was true then, and rewriting them would be falsifying
# the record. What must not exist is a live instruction in a live document.
LIVE_DOCS="docs/FOUNDER_OPERATING_PLAYBOOK.md docs/CONSTITUTION.md docs/REPOSITORY_CONTEXT_INDEX.md"
STALE=""
for f in $LIVE_DOCS; do
  # Match a command, not the word: `bun install`, `bun run`, `bunx`. The prose that explains
  # why bun was removed is allowed to name it.
  HITS="$(grep -nE '(^|[^a-zA-Z/.-])(bun|bunx) (install|run|add|remove|x|create)' "$f" 2>/dev/null || true)"
  if [ -n "$HITS" ]; then
    STALE="$STALE $f"
    fail "$f instructs a command that cannot run (bun.lock was deleted in 7af6238): $HITS"
  fi
done
if [ -z "$STALE" ]; then
  pass "no live document instructs bun, and the deleted lockfile is not referenced as a step"
fi

section "Every npm run script a document names exists"
SCRIPTS="$(node -e 'console.log(Object.keys(require("./package.json").scripts).join(" "))')"
MISSING=""
for f in $LIVE_DOCS; do
  # `npm run foo` and `npm run foo -- --bar` both name the script `foo`.
  NAMED="$(grep -oE 'npm run [a-z0-9:_-]+' "$f" 2>/dev/null | awk '{print $3}' | sort -u || true)"
  for script in $NAMED; do
    if ! printf '%s' " $SCRIPTS " | grep -q " $script "; then
      MISSING="$MISSING $script"
      fail "$f tells the reader to 'npm run $script', which is not a script in package.json"
    fi
  done
done
if [ -z "$MISSING" ]; then
  pass "every 'npm run' instruction in a live document resolves to a real script"
fi

section "The scripts a document names actually exist on disk"
# `npm run verify:layer4` can name a script that runs `bash scripts/verify-layer4.sh`, and
# that file can be renamed while the script entry keeps working. Check the file too.
BROKEN_SCRIPTS=""
for f in $LIVE_DOCS; do
  for script in $(grep -oE 'npm run [a-z0-9:_-]+' "$f" 2>/dev/null | awk '{print $3}' | sort -u); do
    BODY="$(node -e "console.log(require('./package.json').scripts['$script'] || '')" 2>/dev/null)"
    for referenced in $(printf '%s' "$BODY" | grep -oE 'scripts/[a-zA-Z0-9._-]+' | sort -u); do
      if [ ! -f "$referenced" ]; then
        BROKEN_SCRIPTS="$BROKEN_SCRIPTS $referenced"
        fail "$f -> npm run $script -> $referenced does not exist"
      fi
    done
  done
done
if [ -z "$BROKEN_SCRIPTS" ]; then
  pass "every script file a live document reaches exists on disk"
fi

section "The package manager the lockfile agrees with is the one documented"
# If a second lockfile reappears, ADR-007 is being violated and the docs are wrong again.
FOREIGN=""
for candidate in bun.lock bun.lockb yarn.lock pnpm-lock.yaml; do
  if [ -f "$candidate" ]; then
    FOREIGN="$FOREIGN $candidate"
    fail "$candidate is tracked; ADR-007 makes npm canonical and this is a second lockfile"
  fi
done
if [ -z "$FOREIGN" ]; then
  pass "no lockfile other than package-lock.json is tracked"
fi

section "The constitution claims match the code"
# The recurring lapse: a non-conformance resolved by one commit and still listed as open by
# the next. NC-3, NC-4 and NC-5 were all resolved and all three left in the open table. This
# cannot detect a *stale* description, but it can detect the structural drift that caused it:
# a resolved row that is not in the Resolved section.
CONSTITUTION=docs/CONSTITUTION.md
if [ ! -f "$CONSTITUTION" ]; then
  fail "docs/CONSTITUTION.md is missing; the governance record is required"
else
  TOTAL="$(grep -cE '^\|\s*NC-[0-9]+\s*\|' "$CONSTITUTION" || true)"
  RESOLVED="$(awk '/^### Resolved/,0' "$CONSTITUTION" | grep -cE '^\|\s*NC-[0-9]+\s*\|' || true)"
  OPEN="$(awk '/^## Known non-conformances/,/^### Resolved/' "$CONSTITUTION" | grep -cE '^\|\s*NC-[0-9]+\s*\|' || true)"
  if [ "$((RESOLVED + OPEN))" -eq "$TOTAL" ]; then
    pass "all $TOTAL non-conformances are accounted for: $RESOLVED resolved, $OPEN open"
  else
    fail "$TOTAL NC rows exist but only $((RESOLVED + OPEN)) are classified as resolved or open"
  fi
  # Every resolved row must name the commit that resolved it. A resolution with no commit is
  # not auditable, and an unauditable resolution is how the drift went unnoticed.
  NO_COMMIT="$(awk '/^### Resolved/,0' "$CONSTITUTION" | grep -E '^\|\s*NC-[0-9]+\s*\|' | grep -vE '`[0-9a-f]{7}`' | grep -vcE 'Wave [0-9]' || true)"
  if [ "$NO_COMMIT" -eq 0 ]; then
    pass "every resolved non-conformance names the commit or wave that resolved it"
  else
    fail "$NO_COMMIT resolved non-conformance rows name no commit or wave, so they are not auditable"
  fi
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ DOCS GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
else
  printf '\033[31m════ DOCS GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
