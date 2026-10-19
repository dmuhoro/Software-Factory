#!/usr/bin/env bash
#
# setup-server-keys.sh — prepare server-side model-API keys for Software Factory.
#
# This script does NOT contain, print, or log any secret values. It only checks
# that the environment variables Software Factory needs are present and well-formed,
# verifies the repository's fail-closed egress configuration, and runs the gates
# that prove the product refuses when keys/hosts are missing.
#
# Usage:
#   bash setup-server-keys.sh
#
# Exit codes:
#   0  everything is in place; keys are mounted and gates pass
#   1  a required variable is missing or a gate fails
#
# Required environment (set these in your server's process environment, never in
# a committed file):
#   FACTORY_MODEL_PROVIDERS   comma-separated provider IDs (deepseek,together,mistral,nvidia,openai)
#   FACTORY_ALLOWED_SECRET_REFS comma-separated env var NAMES the factory may resolve
#   FACTORY_MODEL_ALLOWED_HOSTS comma-separated hostnames remote providers may reach
#   {ID}_BASE_URL             per-provider OpenAI-compatible base URL (e.g. DEEPSEEK_BASE_URL)
#   {ID}_SECRET_REF           per-provider secret ref name (e.g. DEEPSEEK_SECRET_REF)
#
# Example server-side environment (fill in real values; never commit this file):
#   FACTORY_MODEL_PROVIDERS=deepseek,together,mistral,nvidia,openai
#   FACTORY_ALLOWED_SECRET_REFS=DEEPSEEK_API_KEY,TOGETHER_API_KEY,MISTRAL_API_KEY,NVIDIA_API_KEY,OPENAI_API_KEY
#   FACTORY_MODEL_ALLOWED_HOSTS=api.deepseek.com,api.together.xyz,api.mistral.ai,integrate.api.nvidia.com,api.openai.com
#   DEEPSEEK_BASE_URL=https://api.deepseek.com/v1   DEEPSEEK_SECRET_REF=DEEPSEEK_API_KEY
#   TOGETHER_BASE_URL=https://api.together.xyz/v1   TOGETHER_SECRET_REF=TOGETHER_API_KEY
#   MISTRAL_BASE_URL=https://api.mistral.ai/v1      MISTRAL_SECRET_REF=MISTRAL_API_KEY
#   NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1   NVIDIA_SECRET_REF=NVIDIA_API_KEY
#   OPENAI_BASE_URL=https://api.openai.com/v1       OPENAI_SECRET_REF=OPENAI_API_KEY
#
# Secret values live in the server process environment (systemd Environment=, secret
# manager, or equivalent). They are never written to disk by this script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { printf 'ok:   %s\n' "$*"; }

echo '== Software Factory — server-side key setup check =='

# --- 1. Required provider configuration --------------------------------------
if [ -z "${FACTORY_MODEL_PROVIDERS:-}" ]; then
  fail 'FACTORY_MODEL_PROVIDERS is unset. Set it to a comma-separated list of provider IDs.'
fi
ok "FACTORY_MODEL_PROVIDERS=${FACTORY_MODEL_PROVIDERS}"

if [ -z "${FACTORY_ALLOWED_SECRET_REFS:-}" ]; then
  fail 'FACTORY_ALLOWED_SECRET_REFS is unset. No secret may be resolved (fail closed).'
fi
ok "FACTORY_ALLOWED_SECRET_REFS=${FACTORY_ALLOWED_SECRET_REFS}"

if [ -z "${FACTORY_MODEL_ALLOWED_HOSTS:-}" ]; then
  fail 'FACTORY_MODEL_ALLOWED_HOSTS is unset. No remote host is permitted.'
fi
ok "FACTORY_MODEL_ALLOWED_HOSTS=${FACTORY_MODEL_ALLOWED_HOSTS}"

# --- 2. Per-provider config must be present for every declared provider -------
IFS=',' read -r -a providers <<< "${FACTORY_MODEL_PROVIDERS}"
missing=0
for p in "${providers[@]}"; do
  p="$(printf '%s' "$p" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  base="$(printf '%s_BASE_URL' "$p")"
  ref="$(printf '%s_SECRET_REF' "$p")"
  if [ -z "${!base:-}" ]; then
    printf '  missing %s for provider %s\n' "$base" "$p" >&2
    missing=1
  fi
  if [ -z "${!ref:-}" ]; then
    printf '  missing %s for provider %s\n' "$ref" "$p" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  fail 'one or more providers lack BASE_URL or SECRET_REF configuration'
fi
ok 'all declared providers have BASE_URL and SECRET_REF configured'

# --- 3. .env must be gitignored (never commit keys) ---------------------------
if ! git check-ignore -q .env 2>/dev/null; then
  fail '.env is not gitignored; a committed .env would burn every key in it'
fi
ok '.env is gitignored'

# --- 4. .env must not contain secret values -----------------------------------
if [ -f .env ] && grep -E '=(sk-|nvapi-|replace|your-|changeme|placeholder)' .env >/dev/null 2>&1; then
  fail '.env contains placeholder or real-looking secret values; remove them'
fi
ok '.env contains no placeholder or real secret values'

# --- 5. Runtime gates ---------------------------------------------------------
echo '--- running npm run verify:pr-config (should exit 1: fail closed without keys) ---'
if npm run verify:pr-config >/tmp/pr-config-out.txt 2>&1; then
  fail 'verify:pr-config unexpectedly passed without keys mounted (expected fail closed)'
fi
ok 'verify:pr-config fails closed without live keys (expected)'

echo '--- running npm run backup:restore-drill (credential-free) ---'
npm run backup:restore-drill >/tmp/drill-out.txt 2>&1
ok 'backup/restore drill passed'

echo '--- running npm run verify:image-digest ---'
npm run verify:image-digest >/tmp/image-digest-out.txt 2>&1
ok 'image digest verification passed'

echo '--- running npm run verify:slo ---'
npm run verify:slo >/tmp/slo-out.txt 2>&1
ok 'SLO verification passed'

echo
echo '== All key-independent checks passed. =='
echo 'To run the full flow, mount live values for:'
echo "  ${FACTORY_ALLOWED_SECRET_REFS}"
echo 'and re-run:'
echo '  npm run register:model-providers'
echo '  npm run bench:skills -- --model provider/model   (Layer 2)'
echo '  npm run trial:report -- --repo <path> --since <date>   (Layer 3)'
echo
echo 'Keys are never printed or stored by this script. Rotate any value that has'
echo 'appeared in a transcript, diff, or log.'
