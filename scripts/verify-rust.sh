#!/usr/bin/env bash
# Rust gate for the dashboard: fmt, clippy, and the full test suite, summarised on one line.
#
# The dashboard originally inlined this as a `bash -c` string containing an awk program, which
# is three levels of quoting wrapped around the one number most likely to be misread. A
# "0 passed" line reached the dashboard that way, because `tail` had shown the last of several
# "test result" lines rather than their sum. This script prints the sum, and fails on any
# failure rather than printing a passing-looking line.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/../software_factory" || exit 1

cargo fmt --check || { echo "rust: fmt is not clean"; exit 1; }
cargo clippy --all-targets -- -D warnings >/dev/null 2>&1 || { echo "rust: clippy reported warnings (-D warnings)"; exit 1; }
cargo test 2>&1 | tee /tmp/sf-rust-dashboard.log | grep -E "^test result" | awk '
  { passed += $4; failed += $6 }
  END {
    if (failed > 0) { print "rust: " passed " passed, " failed " failed"; exit 1 }
    if (passed == 0) { print "rust: no tests ran"; exit 1 }
    print "rust: " passed " passed, 0 failed"
  }'
