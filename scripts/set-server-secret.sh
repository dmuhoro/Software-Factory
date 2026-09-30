#!/usr/bin/env bash
# Put a credential into a server-side secret store, without it ever appearing in a terminal,
# in shell history, or in the process table.
#
# This is the counterpart to scripts/set-secret.sh. That one writes the local .env; this one
# writes the place a server actually reads, so a rotation does not have to be done in two places
# by hand and drift.
#
# The value is read with terminal echo off and handed to the secret store on stdin. It is never
# passed as a command-line argument: arguments are visible to every other process on the box via
# `ps`, which would publish the credential to anyone with a shell on the same host.
set -euo pipefail

KEY=""
REPO=""
ENVIRONMENT=""
SOURCE=""
DRY_RUN=0

usage() {
  cat >&2 <<'USAGE'
usage: set-server-secret.sh --name <ENV_NAME> [options]

  --name <ENV_NAME>        secret name, UPPER_SNAKE_CASE
  --repo <owner/name>      target repository (required unless --org is used)
  --org <name>             target organisation
  --environment <name>     GitHub environment to scope the secret to
  --from-env               read the value from the named environment variable instead of prompting
  --dry-run                do everything except call the secret store; prints the command shape only
  -h, --help               this text

The value is read from the terminal with echo off, or from the environment with --from-env.
It is written to the store on stdin, never as an argument.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) KEY="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --org) ORGANISATION="${2:-}"; shift 2 ;;
    --environment) ENVIRONMENT="${2:-}"; shift 2 ;;
    --from-env) SOURCE="env"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$KEY" ]; then
  printf 'refusing to run without --name\n\n' >&2; usage; exit 2
fi

case "$KEY" in
  *[!A-Z_]*|'') printf 'refusing %s: expected an UPPER_SNAKE_CASE secret name\n' "$KEY" >&2; exit 2 ;;
esac

if [ -z "$REPO" ] && [ -z "${ORGANISATION:-}" ]; then
  printf 'refusing to run without a target: pass --repo owner/name or --org name\n' >&2; exit 2
fi

# Read the value. `--from-env` exists so a rotation can be a single non-interactive step in CI,
# where there is no terminal to turn echo off on.
if [ "$SOURCE" = "env" ]; then
  VALUE="${!KEY-}"
  [ -n "$VALUE" ] || { printf 'refusing: %s is empty in this environment\n' "$KEY" >&2; exit 1; }
else
  printf 'Enter the value for %s (input hidden): ' "$KEY" >&2
  stty -echo 2>/dev/null || true
  # `read` returns non-zero on a final line with no trailing newline, which is a normal way to
  # pipe a value in. Treating that as "no value" silently discarded a perfectly good credential and
  # then reported the file as unchanged, so the read status is ignored and emptiness is judged
  # separately below, where the message can be accurate.
  IFS= read -r VALUE || true
  stty echo 2>/dev/null || true
  printf '\n' >&2
fi

if [ -z "$VALUE" ]; then
  printf 'no value given; %s not set anywhere\n' "$KEY" >&2
  exit 1
fi

# The same minimum the product enforces at startup, so a short secret cannot be stored and then
# fail the server on boot with an error that points nowhere near the cause.
case "$KEY" in
  *API_KEY|*_SECRET|*_PASSWORD)
    if [ "${#VALUE}" -lt 32 ]; then
      printf 'refusing %s: %d characters is below the 32-character minimum this product enforces\n' \
        "$KEY" "${#VALUE}" >&2
      exit 1
    fi
    ;;
esac

case "$VALUE" in
  *$'\n'*|*$'\r'*) printf 'refusing %s: the value contains a line break\n' "$KEY" >&2; exit 1 ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  printf 'refusing to run: the GitHub CLI is not installed, so there is no verified way to set this secret\n' >&2
  exit 1
fi

# Build the gh invocation. Note the absence of the value from every element: it arrives on stdin.
set -- secret set "$KEY"
[ -n "$REPO" ] && set -- "$@" --repo "$REPO"
[ -n "${ORGANISATION:-}" ] && set -- "$@" --org "$ORGANISATION"
[ -n "$ENVIRONMENT" ] && set -- "$@" --env "$ENVIRONMENT"

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN. Would send %s to the store on stdin as:\n' "$KEY" >&2
  printf '  gh %s   (value on stdin, never an argument)\n' "$*" >&2
  printf 'No secret was written anywhere.\n' >&2
  exit 0
fi

printf 'writing %s to the secret store (value not shown)...\n' "$KEY" >&2
printf '%s' "$VALUE" | gh "$@"

unset VALUE

# Report the fact of the change, never the content. `gh secret list` shows names and timestamps.
printf '\n%s is now set. Confirming by name:\n' "$KEY" >&2
if [ -n "$REPO" ]; then
  gh secret list --repo "$REPO" ${ENVIRONMENT:+--env "$ENVIRONMENT"} 2>/dev/null \
    | awk -v k="$KEY" '$1 == k { print "  confirmed: " $1 " (updated " $3 ")"; found = 1 } END { if (!found) print "  WARNING: " k " does not appear in the list" }'
elif [ -n "${ORGANISATION:-}" ]; then
  gh secret list --org "$ORGANISATION" 2>/dev/null \
    | awk -v k="$KEY" '$1 == k { print "  confirmed: " $1 " (updated " $3 ")"; found = 1 } END { if (!found) print "  WARNING: " k " does not appear in the list" }'
fi
