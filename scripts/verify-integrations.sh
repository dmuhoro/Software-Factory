#!/usr/bin/env bash
#
# Assert that the integration gates cannot report a pass they did not earn.
#
# The failure this prevents is specific and it is the reason this file exists. A CI job
# guarded by `if: secrets.X != ''` is skipped when the secret is absent -- which is correct --
# but a job whose steps all `continue-on-error`, or whose scanner exits zero on an empty
# result, produces a green check that means nothing was verified. This repository has a
# history of exactly that shape: CI stayed green through every release while the production
# image could not be built and the egress policy permitted the entire internet.
#
# So this asserts the shape of the workflow rather than its runtime behaviour, because the
# behaviour cannot be observed without the secrets. The assertions are about what would happen
# if the secrets were present, which is exactly the part that was previously unverified.
#
# Usage: scripts/verify-integrations.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

WF=.github/workflows/integrations.yml

section "The workflow parses and every job is declared"
if ! python3 -c "
import yaml, sys
d = yaml.safe_load(open('$WF'))
jobs = d['jobs']
assert set(jobs) == {'coderabbit', 'sonarqube', 'snyk', 'datadog-metrics'}, sorted(jobs)
for name, job in jobs.items():
    assert 'if' in job, f'{name} has no condition and would run for a fork PR without credentials'
    assert 'steps' in job, f'{name} has no steps'
" 2>/tmp/sf-int-err.txt; then
  fail "the workflow does not parse as expected: $(cat /tmp/sf-int-err.txt | tail -2)"
else
  pass "4 jobs declared, each with a condition and steps"
fi

section "Every credential-gated job is conditioned on a secret"
# Each of these must be gated. An ungated SonarQube or Snyk job fails the whole workflow for
# a fork PR, and a repository that punishes outside contributions with red CI will not get
# outside contributions.
for job_secret in "coderabbit:CODERABBIT_API_KEY" "sonarqube:SONAR_TOKEN" "snyk:SNYK_TOKEN" "datadog-metrics:DATADOG_API_KEY"; do
  JOB="${job_secret%%:*}"
  SECRET="${job_secret##*:}"
  if python3 -c "
import yaml
d = yaml.safe_load(open('$WF'))
cond = d['jobs']['$JOB'].get('if', '')
assert 'secrets.$SECRET' in cond, cond
" 2>/dev/null; then
    pass "$JOB is gated on secrets.$SECRET"
  else
    fail "$JOB is not gated on secrets.$SECRET; it would run without the credential"
  fi
done

section "No step is allowed to fail silently"
# continue-on-error, or a `|| true`, on a security or quality job converts a real failure into
# a green check. The one exception is a job that publishes a metric, and even there the
# publish failure must be visible -- so no exceptions are granted here at all.
SILENT="$(grep -nE 'continue-on-error|\|\| *(true|exit 0)' "$WF" || true)"
if [ -n "$SILENT" ]; then
  fail "a step can fail silently: $SILENT"
else
  pass "no step uses continue-on-error or '|| true'/'|| exit 0'"
fi

section "Quality and security gates actually gate"
# Snyk and SonarQube both have a documented default of annotating without failing. Without an
# explicit fail, they report findings nobody is required to read.
if grep -q 'sonar.qualitygate.wait=true' "$WF"; then
  pass "SonarQube waits on the quality gate rather than annotating only"
else
  fail "SonarQube does not wait on the quality gate; findings would not fail the build"
fi
if grep -q -- '--fail-on=high' "$WF"; then
  pass "Snyk is invoked with an explicit --fail-on threshold"
else
  fail "Snyk has no --fail-on threshold; high vulnerabilities would not fail the build"
fi
if grep -q -- '--severity-threshold=high' "$WF"; then
  pass "Snyk scans at high severity and above"
else
  fail "Snyk has no severity threshold; informational findings would dominate the output"
fi

section "Fork pull requests are not blocked by absent secrets"
# The integration workflow must not turn a contributor's PR red for something they cannot fix.
FORK_UNSAFE="$(python3 -c "
import yaml
d = yaml.safe_load(open('$WF'))
print(','.join(n for n, j in d['jobs'].items() if 'if' not in j))
" 2>/dev/null)"
if [ -z "$FORK_UNSAFE" ]; then
  pass "no integration job runs unconditionally on a pull request"
else
  fail "these integration jobs run unconditionally and would fail for a fork PR: $FORK_UNSAFE"
fi

section "The knowledge base is what feeds CodeRabbit"
# Without this the MCP server is an unused file, and the integration is a generic AI reviewer
# that knows nothing about this repository's rules.
if grep -q 'kb-mcp-server.mjs' "$WF"; then
  pass "the knowledge base MCP server is verified in the CodeRabbit job"
else
  fail "the CodeRabbit job does not reference the knowledge base server"
fi
if grep -q 'docs/CONSTITUTION.md' "$WF"; then
  pass "CodeRabbit path instructions cite the constitution"
else
  fail "CodeRabbit has no path instructions; it would review the diff with no repository rules"
fi

section "Nothing here claims to measure production"
# The runtime exposes /metrics, verified by scripts/verify-image.sh. Nothing in CI can reach a
# production pod. A comment implying otherwise would be a false claim in the one file an
# operator is likely to trust about production health.
WF_STEPS="$(grep -vE '^[[:space:]]*#' "$WF")"
if printf '%s' "$WF_STEPS" | grep -qiE 'scrape[sd]? production|live production metrics|production_telemetry'; then
  fail "a workflow step claims production measurement it cannot perform"
else
  pass "no workflow step claims production measurement (comments excluded)"
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m════ INTEGRATIONS GATE: %d passed, 0 failed ════\033[0m\n' "$PASS"
else
  printf '\033[31m════ INTEGRATIONS GATE: %d passed, %d FAILED ════\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
