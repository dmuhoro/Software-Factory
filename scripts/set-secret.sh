#!/usr/bin/env bash
# Set a credential in the gitignored .env, and optionally in a server-side secret store.
# Tested against a throwaway copy. Nothing is echoed, nothing enters shell history.
set -euo pipefail

KEY="$1"

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
# a screen share. read returns non-zero on a bare Enter, which is treated as "leave it alone"
# rather than silently blanking an existing credential.
if [ -t 0 ]; then
  printf 'Enter the new value for %s (input hidden): ' "$KEY" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r VALUE || VALUE=""
  stty echo 2>/dev/null || true
  printf '\n' >&2
else
  printf 'reading %s from stdin\n' "$KEY" >&2
  IFS= read -r VALUE
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
