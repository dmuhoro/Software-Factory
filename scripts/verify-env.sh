#!/usr/bin/env bash
# Neutralise ambient configuration before a verification harness measures anything.
#
# ## Why this exists
#
# Each layer harness starts the real server with `env FACTORY_...=... node`. `env` adds to the
# environment it inherits; it does not replace it. So a developer who has `source .env` in their
# shell exports production-shaped values that the harness never sets, and the server inherits them.
#
# Observed directly: with `.env` sourced, all four layer harnesses failed with
#
#     refusing to start: ALLOW_INSECURE_LOCAL=true disables credential checks for loopback
#     callers and must never be set in production
#
# which is the product behaving correctly and the harness being wrong. Unsetting the variable made
# the harnesses pass again -- on the same commit, with no code change. A gate whose result depends
# on which shell launched it is not measuring the product.
#
# The same leak had a second effect: `dotenv/config` loads the repository `.env` from the working
# directory, so unsetting in the parent is not enough on its own. The harnesses run the server
# from the repository root, so `FACTORY_*_ROOT` values from `.env` arrive through dotenv. Only the
# variables a harness does not set itself need unsetting, and dotenv never overrides a variable that
# is already exported, so pinning the ones the harness cares about continues to work.
#
# ## What it does
#
# Unsets the variables a harness must own. It is sourced, not executed, so the caller's shell
# options survive.
#
# It deliberately does NOT unset `ALLOW_INSECURE_LOCAL` for harnesses that are *testing* that
# refusal: those set it inline on the `env` command line, which still applies.
#
# Not a product concern, so this never loads from `server.ts`. Silently rewriting an operator's
# configured paths at startup would be worse than the problem it fixes.

# The workspace roots the harnesses manage themselves, plus the local-bypass and model keys that
# change whether a request succeeds. A key inherited from a developer's shell must not decide
# whether a layer test passes.
unset \
  FACTORY_WORKSPACE_ROOT \
  FACTORY_CLIENT_WORKSPACE_ROOT \
  FACTORY_WORKTREE_ROOT \
  FACTORY_SANDBOX_ROOT \
  FACTORY_ARTIFACT_ROOT \
  FACTORY_DATA_DIR \
  FACTORY_API_KEY \
  FACTORY_TENANT_CREDENTIALS \
  FACTORY_TENANT_SEED_DEMO \
  FACTORY_ALLOWED_SECRET_REFS \
  FACTORY_ALLOWED_MODEL_HOSTS \
  ALLOW_INSECURE_LOCAL \
  GEMINI_API_KEY \
  GOOGLE_API_KEY \
  NODE_OPTIONS \
  STORAGE_BACKEND \
  2>/dev/null || true
