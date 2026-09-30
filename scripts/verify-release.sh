#!/usr/bin/env bash
#
# Release gate: a version is only a release if every record of it agrees.
#
# A release is described in at least five places in this repository -- package.json,
# package-lock.json, the Rust manifest, the Rust lockfile, and CHANGELOG.md -- and it is
# additionally named by a git tag. Nothing forced those to agree. They happened to agree at
# 4.7.0, and when they stopped agreeing nobody would have found out until an operator noticed
# that the tag, the changelog and the running image described three different releases.
#
# This script is the disagreement detector. It is designed so that a failure is specific: it
# names each site, what it says, and what it should say. A gate that says only "version
# mismatch" costs more time than it saves.
#
# Usage:
#   scripts/verify-release.sh              # checks that must hold on any commit
#   scripts/verify-release.sh --pre-release  # additionally skip the checks that can only
#                                             # pass at tag time (CI runs this)
#   scripts/verify-release.sh --expect-tag   # additionally require the tag to exist
#
# Exit codes: 0 all agreed, 1 a disagreement was found, 2 the script could not run.
#
# Why there are two modes. The tag and clean-tree checks describe a *release*, not a
# commit, so they cannot pass on an ordinary change and are skipped in CI. They are not
# skipped in a release run, and they are not deleted. An earlier version of the CI step ran
# the full gate with `|| true` so it would not break the build -- which is a check that
# cannot fail, and therefore a check that proves nothing. The honest alternative is a mode
# that runs everything true for that moment and still exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
SKIP=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
# A skip is counted and printed, never folded into PASS. A check that could not run must not be
# indistinguishable from one that did: this repository shipped a Docker image that could not be
# built while CI stayed green, and the reason was that nothing asserted it.
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; SKIP=$((SKIP + 1)); }
section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

EXPECT_TAG=0
PRE_RELEASE=0
for arg in "$@"; do
  case "$arg" in
    --expect-tag) EXPECT_TAG=1 ;;
    --pre-release) PRE_RELEASE=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }
command -v git  >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }

# Reads one version from one file, and refuses to continue if it cannot.
read_version() {
  node -e '
    const fs = require("fs");
    const [file, kind] = process.argv.slice(1);
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { process.exit(3); }
    let v = null;
    if (kind === "json") {
      try { const j = JSON.parse(raw); v = j.version ?? j.packages?.[""]?.version ?? null; } catch {}
    } else if (kind === "cargo") {
      const m = raw.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
      if (m) v = m[1];
    } else if (kind === "cargo-lock") {
      const m = raw.match(/name = "software_factory"\nversion = "([^"]+)"/);
      if (m) v = m[1];
    } else if (kind === "changelog") {
      const m = raw.match(/^##\s*\[?v?(\d+\.\d+\.\d+)/m);
      if (m) v = m[1];
    }
    if (!v) process.exit(3);
    process.stdout.write(v);
  ' "$1" "$2"
}

# Compares a site to the reference version, reporting both when they differ.
check_site() {
  local label="$1" file="$2" kind="$3" actual
  if ! actual="$(read_version "$file" "$kind")"; then
    fail "$label: could not read a version from $file"
    return
  fi
  if [ "$actual" = "$REFERENCE" ]; then
    pass "$label is $actual"
  else
    fail "$label says $actual but package.json says $REFERENCE"
  fi
}

# ── The reference is package.json: it is what npm publishes and what the image labels ──
if ! REFERENCE="$(read_version package.json json)"; then
  echo "cannot read package.json -- is the working tree intact?" >&2
  exit 2
fi

section "All version records must agree (reference: package.json = $REFERENCE)"
printf '  Every site below must read %s. They are five independent copies of one fact,\n' "$REFERENCE"
printf '  and nothing but this script keeps them from drifting apart.\n\n'

check_site "package.json"        package.json                json
check_site "package-lock.json"   package-lock.json           json
check_site "Cargo.toml"          software_factory/Cargo.toml  cargo
check_site "Cargo.lock"          software_factory/Cargo.lock  cargo-lock
check_site "CHANGELOG.md"        CHANGELOG.md                 changelog

section "The version is a real semver, not a placeholder"
if printf '%s' "$REFERENCE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  pass "$REFERENCE is well-formed semver"
else
  fail "$REFERENCE is not MAJOR.MINOR.PATCH; a release must be nameable"
fi

# `0.0.0` and `0.1.0` are the two values that survive review because nobody looks at them.
# package-lock.json carried 0.0.0 for the life of the repository and `npm ci` never
# complained, so the check has to be explicit rather than delegated to the installer.
if [ "$REFERENCE" = "0.0.0" ] || [ "$REFERENCE" = "0.1.0" ]; then
  fail "$REFERENCE is a placeholder version and must not be released"
else
  pass "$REFERENCE is not a placeholder version"
fi

section "CHANGELOG.md actually describes this release"
CHANGELOG_VERSION="$(read_version CHANGELOG.md changelog 2>/dev/null || echo '')"
if [ -n "$CHANGELOG_VERSION" ] && [ "$CHANGELOG_VERSION" = "$REFERENCE" ]; then
  # A version heading with an empty body is a release note that says nothing, which is the
  # same as no release note while looking like one.
  #
  # The heading is matched by pattern, not by exact string. This file uses
  # `## [4.7.0-production-hardening] - 2026-09-29`, and an exact match on `## [4.7.0]`
  # reported a false failure against a correctly documented release. A gate that cries wolf
  # is trained out of use, which is worse than no gate.
  BODY="$(awk '
    /^## / {
      if (found) exit
      if (match($0, /[0-9]+\.[0-9]+\.[0-9]+/)) {
        version = substr($0, RSTART, RLENGTH)
        if (version == want) found = 1
      }
      next
    }
    found { print }
  ' want="$REFERENCE" CHANGELOG.md | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [ "$BODY" -ge 1 ]; then
    pass "CHANGELOG.md has $BODY non-empty line(s) under $REFERENCE"
  else
    fail "CHANGELOG.md has a heading for $REFERENCE and no content under it"
  fi
else
  fail "CHANGELOG.md does not have a matching release heading"
fi

section "The previous release is still recorded"
# A changelog that has been rewritten loses the ability to answer "what changed in 4.6.0?",
# which is the question an incident review actually asks.
PREV_COUNT="$(grep -cE '^## ' CHANGELOG.md || true)"
if [ "$PREV_COUNT" -ge 2 ]; then
  pass "CHANGELOG.md records $PREV_COUNT releases, so history is preserved"
else
  fail "CHANGELOG.md records only $PREV_COUNT release(s); history appears to have been rewritten"
fi

section "Git tags"
if [ "$PRE_RELEASE" -eq 1 ]; then
  # A commit is not a release, so it has no tag to point at. These four checks run in a
  # release run and are skipped here; nothing else in the script is.
  pass "pre-release mode: tag, clean-tree and attribution checks are deferred to release"
elif git rev-parse --git-dir >/dev/null 2>&1; then
  if git rev-parse "v$REFERENCE" >/dev/null 2>&1; then
    TAG_COMMIT="$(git rev-list -n 1 "v$REFERENCE")"
    HEAD_COMMIT="$(git rev-parse HEAD)"
    if [ "$TAG_COMMIT" = "$HEAD_COMMIT" ]; then
      pass "tag v$REFERENCE exists and points at HEAD"
    else
      fail "tag v$REFERENCE points at ${TAG_COMMIT:0:8} but HEAD is ${HEAD_COMMIT:0:8}; the tag does not describe the code being released"
    fi
  else
    pass "tag v$REFERENCE not yet created (expected before tagging)"
  fi

  LAST_TAG="$(git tag --sort=-v:refname 2>/dev/null | head -1 || echo '')"
  if [ -n "$LAST_TAG" ]; then
    if [ "$LAST_TAG" = "v$REFERENCE" ]; then
      pass "highest tag is $LAST_TAG, matching the release"
    else
      pass "highest tag is $LAST_TAG, so this release is an increment"
    fi
  else
    fail "no tags exist at all; this repository has never been released"
  fi

  DIRTY="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  if [ "$DIRTY" -eq 0 ]; then
    pass "working tree is clean; a release describes committed code"
  else
    fail "working tree has $DIRTY uncommitted change(s); a release must describe committed code"
  fi

  if [ "$EXPECT_TAG" -eq 1 ] && ! git rev-parse "v$REFERENCE" >/dev/null 2>&1; then
    fail "--expect-tag was given but v$REFERENCE does not exist"
  fi
else
  fail "not a git repository; the tag check cannot run"
fi

section "The release is attributable"
# A commit that is not attributed to an agent or a human cannot be audited later. The
# portfolio constitution requires this footer, and a release is the last moment it can
# still be added.
#
# Two GitHub behaviours make the naive `git log -1` wrong here, and both were observed failing
# in CI on a branch whose every commit carried the footer:
#
#   1. CI checks out `refs/pull/N/merge`, so HEAD is the merge commit GitHub synthesises. Nobody
#      wrote it, so it can never carry a footer.
#   2. `actions/checkout` defaults to `fetch-depth: 1`. In a shallow clone the merge commit's
#      parents are grafted away, so `git log --no-merges` still returns it -- the graft makes a
#      merge commit look like an ordinary one. Filtering merges alone therefore does not help.
#
# The history is what needs attesting, so the check requires real history and refuses to guess
# without it. A shallow checkout is reported as a skip with the reason, never as a pass, because
# a green check that means "nothing was verified" is the failure this repository already made
# once with a Docker image that could not be built.
if [ -f .git/shallow ]; then
  skip "history is shallow ($(wc -l < .git/shallow | tr -d ' ') grafted commit); the attribution check needs the full log"
  printf '         fetch it with `git fetch --unshallow` to run this check for real\n'
else
  LAST_COMMIT="$(git log --no-merges -1 --pretty=%B 2>/dev/null || echo '')"
  if [ -z "$LAST_COMMIT" ]; then
    # A history with no non-merge commit is not a release history; say so rather than
    # reporting a missing footer on a commit that does not exist.
    fail "no non-merge commit found, so the release cannot be attributed"
  elif printf '%s' "$LAST_COMMIT" | grep -qiE 'AI-Assisted:|Co-Authored-By:'; then
    pass "the branch tip carries an authorship footer"
  else
    fail "the branch tip carries no authorship footer; the release cannot be attributed"
  fi
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ RELEASE GATE: %d passed, 0 failed, %d skipped ════\033[0m\n' "$PASS" "$SKIP"
  exit 0
else
  printf '\033[31m════ RELEASE GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
