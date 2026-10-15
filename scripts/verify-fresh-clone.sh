#!/usr/bin/env bash
#
# Reproducibility gate (Sprint 31, WP-1).
#
# A clone of the committed tree — no node_modules, no .env, no .data, no gitignored
# .claude/ or .agents/ — must install from the lockfile, typecheck, and pass the suite.
# That is the claim the local suite cannot make: that green is a property of the
# repository, and not of the machine it happened to run on. The doctrine self-stage test
# once passed only because a gitignored directory happened to exist; this gate is what
# notices that class of defect, because the clone has none of those files.
#
# Fail-closed: any step that cannot run fails the gate. There is no "|| true" here.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
HEAD_SHA="$(git rev-parse HEAD)"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "cloning the committed tree at ${HEAD_SHA:0:7} into $WORK/clone"
git clone -q "$ROOT" "$WORK/clone"
git -C "$WORK/clone" checkout -q --detach "$HEAD_SHA"

if [ -n "$(git -C "$WORK/clone" status --porcelain)" ]; then
  echo "FAIL a fresh clone is not a clean tree"
  exit 1
fi

cd "$WORK/clone"

echo "installing from the lockfile (npm ci)"
npm ci --no-audit --no-fund

# The sandbox is a precondition of the suite. Prove it here, by name, so a host without
# bubblewrap fails with a clear message instead of dozens of opaque test failures.
echo "proving the sandbox can unshare"
bwrap --version
bwrap --unshare-user-try --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
  --unshare-net --die-with-parent --new-session --ro-bind / / --dev /dev --proc /proc \
  /bin/sh -c 'echo sandbox preflight ok'

echo "typecheck"
npx tsc --noEmit

echo "suite"
npm test

echo "PASS a fresh clone installs and verifies (typecheck + suite)"
