#!/usr/bin/env bash
# Keep the documented Appwrite scopes equal to the operations the code actually performs.
#
# Why this is a gate and not a comment: scope requirements drift silently. A developer adds a
# column-creation call to the server, the runtime key needs tables.write to keep working, and
# nothing says so -- so the fix that gets applied under time pressure is "grant the runtime key
# everything", which quietly hands every server process the ability to rewrite the schema of a
# shared database. That is how a least-privilege split decays.
#
# The claim being checked is narrow and checkable: schema-creating operations appear only in the
# provisioner, and never in the runtime path. The documented scope lists are then verified to
# match that split, so the two cannot disagree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WF=".github/workflows/verify.yml"
pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
head_() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

PROVISIONER="scripts/provision-appwrite.ts"

# The schema-mutating calls. Each is one a runtime process must never need.
SCHEMA_OPS='tables\.createTable|tables\.create[A-Za-z]*Column|tables\.update[A-Za-z]*Column|databases\.create|databases\.update|indexes\.'

# The deployed server, named explicitly rather than as `src/`.
#
# An earlier version of this gate scanned all of `src/` and reported two hits that were both false:
# `src/App.tsx` renders a *code sample* in a <pre> block, and that sample contains a
# `databases.createDocument` call as text. A gate that cries wolf on documentation gets switched
# off, and a switched-off gate protects nothing. So the scan covers the modules that actually
# execute on the server, and `App.tsx`/`main.tsx` are excluded because they are the browser bundle.
#
# The exclusion is a limitation worth stating rather than hiding: a schema call smuggled into the UI
# as executable code would not be caught here. What this gate is for is the realistic failure --
# a developer adding a column migration to the server because it was the convenient place.
RUNTIME_DIRS="src/api src/services src/configurations src/utils src/models scripts"
# Comments are stripped before matching. A gate that reads prose as code is worse than no gate:
# the first false positive costs more trust than the check is worth, and a check that is ignored
# protects nothing. `//`, `*` and `#` line prefixes are dropped, and this script is excluded so the
# gate cannot fail on its own explanation of what it looks for.
RUNTIME_HITS="$(
  grep -rnE "$SCHEMA_OPS" $RUNTIME_DIRS 2>/dev/null \
    | grep -v 'provision-appwrite' \
    | grep -v 'verify-appwrite-scopes.sh' \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|#|\*|/\*)' \
    || true
)"
if [ -n "$RUNTIME_HITS" ]; then
  bad "the deployed server performs schema mutations, so the runtime key would need schema-write scopes:"
  printf '%s\n' "$RUNTIME_HITS" | sed 's/^/          /'
else
  ok "no table, column, index or database creation in the runtime source"
fi

head_ "The documented split matches that reality"
# .env.example must name the runtime scopes and must not hand them to the runtime.
if grep -qE '^#\s*databases\.read\s*$' .env.example \
   && grep -qE '^#\s*rows\.read\s*$' .env.example \
   && grep -qE '^#\s*rows\.write\s*$' .env.example; then
  ok ".env.example names the runtime scopes: databases.read, rows.read, rows.write"
else
  bad ".env.example does not state the runtime scope set (databases.read, rows.read, rows.write)"
fi

# The runtime block is the text between "The runtime key needs" and "To provision".
#
# This was originally extracted with awk using a lowercase marker, while the file says "The".
# The block therefore came back empty on every run, the check examined nothing, and it passed --
# permanently, and vacuously. That is the failure this whole gate exists to prevent, committed in
# the gate itself, so the extraction is now done in Python with the extraction asserted: if the
# block cannot be located, that is a failure, not a pass.
RUNTIME_BLOCK="$(python3 -c "
import re, sys
text = open('.env.example').read()
m = re.search(r'#[^\n]*[Tt]he runtime key needs.*?(?=#[^\n]*To provision)', text, re.S)
sys.stdout.write(m.group(0) if m else '')
")"

# Only the indented scope entries count as grants -- a bare "#     databases.read" line. Prose in
# the same block names scopes it explicitly does NOT want, and grepping the whole block flagged
# that sentence as an over-grant. The distinction matters: the sentence is the thing keeping the
# key narrow, so a gate that fails on it would pressure someone to delete the warning.
GRANTED="$(printf '%s\n' "$RUNTIME_BLOCK" | grep -E '^#[[:space:]]{2,}[a-z]+\.[a-z]+[[:space:]]*$' || true)"

if [ -z "$RUNTIME_BLOCK" ]; then
  bad "could not locate the runtime scope block in .env.example; this check would pass without reading anything"
elif [ -z "$GRANTED" ]; then
  bad "the runtime scope block lists no scopes at all; this check would pass without reading anything"
elif printf '%s\n' "$GRANTED" | grep -qE '(tables|columns|indexes|databases)\.write'; then
  bad ".env.example grants a schema-write scope to the runtime key"
  printf '%s\n' "$GRANTED" | grep -E '(tables|columns|indexes|databases)\.write' | sed 's/^/          /'
else
  ok "the runtime key is granted only: $(printf '%s\n' "$GRANTED" | tr -d '# ' | tr '\n' ' ')"
fi

if grep -qE 'tables\.write' .env.example && grep -qE 'columns\.write' .env.example; then
  ok ".env.example documents the wider provisioner scope set separately"
else
  bad ".env.example does not document the provisioner's schema-write scopes"
fi

head_ "A key with no scopes is called out as the failure it is"
# An empty scope set returns 401, indistinguishable from a wrong project. The advice has to say so
# or an operator rotates a key that was never wrong.
if grep -qi 'EMPTY scope set' .env.example; then
  ok ".env.example warns that an empty scope set produces 401"
else
  bad ".env.example does not warn that a key with no scopes returns 401"
fi

if grep -qi 'user_unauthorized\|401' .env.example; then
  ok ".env.example names the 401 that an unscoped key produces"
else
  bad ".env.example does not connect an unscoped key to its 401"
fi

head_ "The health check classifies a rejected credential"
# Without this, a 401 is reported with advice to set a variable that is already set.
# The advice table uses a bare object key, so match the key rather than a quoted string. The first
# version of this check looked for 'unauthorized' with quotes and reported a defect that was not
# there -- a gate that fails on correct code trains people to ignore it.
if grep -q "unauthorized" src/services/appwriteClient.ts \
   && grep -qE '^\s+unauthorized:\s*\[' scripts/check-appwrite.ts; then
  ok "a 401 is classified and answered with credential advice"
else
  bad "a rejected credential is not classified, so the check cannot give usable advice"
fi

printf '\n\033[1m═══ SCOPE GATE: %d passed, %d failed ═══\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
