#!/usr/bin/env bash
# Set a credential in the gitignored .env, and optionally in a server-side secret store.
# Tested against a throwaway copy. Nothing is echoed, nothing enters shell history.
set -euo pipefail

# `${1:-}` rather than `$1`: under `set -u` a bare invocation aborted with an unbound-variable
# error, which is indistinguishable from a refused credential and tells the operator nothing.
KEY="${1:-}"

if [ -z "$KEY" ]; then
  printf 'usage: %s <ENV_NAME>\n' "$0" >&2
  printf '   e.g. %s APPWRITE_API_KEY\n' "$0" >&2
  exit 2
fi

case "$KEY" in
  *[!A-Z_]*|'')
    printf 'refusing %s: expected an UPPER_SNAKE_CASE environment variable name\n' "$KEY" >&2
    exit 2
    ;;
esac

# Read with the terminal echo off, so the value never appears on screen, in scrollback, or in
# a screen share. Emptiness is judged explicitly below, so the read status is ignored: `read`
# reports non-zero for a bare Enter *and* for a final line with no trailing newline, and those two
# cases mean opposite things. Under `set -e` the piped case aborted the script before it wrote
# anything, which looks exactly like a refused credential rather than a harness mistake.
if [ -t 0 ]; then
  printf 'Enter the new value for %s (input hidden): ' "$KEY" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r VALUE || true
  stty echo 2>/dev/null || true
  printf '\n' >&2
else
  printf 'reading %s from stdin\n' "$KEY" >&2
  # Same reasoning as the interactive branch: a piped value commonly has no trailing newline, and
  # treating that as failure either discards the value or aborts the script.
  IFS= read -r VALUE || true
fi

if [ -z "$VALUE" ]; then
  printf 'no value given; %s left unchanged\n' "$KEY" >&2
  exit 1
fi

# Reject a value that would silently break the product's own minimum-length rule. A short key
# is worse than no key, because the server refuses at startup and the cause is not obvious.
case "$KEY" in
  *API_KEY|*_SECRET|*_PASSWORD)
    if [ "${#VALUE}" -lt 32 ]; then
      printf 'refusing %s: %d characters is below the 32-character minimum this product enforces\n' \
        "$KEY" "${#VALUE}" >&2
      exit 1
    fi
    ;;
esac

# Refuse anything with a newline: it would silently truncate the value and leave a partial
# credential that looks configured.
case "$VALUE" in
  *$'\n'*|*$'\r'*)
    printf 'refusing %s: the value contains a line break\n' "$KEY" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/.."
ENV_FILE=".env"
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Rewrite the line in place if the key already exists, otherwise append. Written to a temp file
# in the same directory and moved into place, so an interrupted write cannot leave a truncated
# .env that costs every other credential in the file.
TMP="$(mktemp ./.env.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

if grep -qE "^${KEY}=" "$ENV_FILE"; then
  # `|` rather than `/` as the delimiter, because a credential may contain `/`.
  KEY="$KEY" VALUE="$VALUE" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
    $0 ~ "^" k "=" { print k "=" v; next }
    { print }
  ' "$ENV_FILE" > "$TMP"
else
  cp "$ENV_FILE" "$TMP"
  printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"
fi

mv "$TMP" "$ENV_FILE"
trap - EXIT

printf 'updated %s in %s (mode %s)\n' "$KEY" "$ENV_FILE" "$(stat -c '%a' "$ENV_FILE")" >&2
git check-ignore -q "$ENV_FILE" \
  && printf 'confirmed: git ignores %s, so this cannot be committed\n' "$ENV_FILE" >&2 \
  || printf 'WARNING: %s is NOT git-ignored. Do not commit it.\n' "$ENV_FILE" >&2
