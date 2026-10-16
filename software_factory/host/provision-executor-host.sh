#!/usr/bin/env bash
# Provision the executor host for the unattended loop (ADR-014, Sprint 31 WP-4).
#
# ## What this script does, and what it refuses to pretend it can do
#
# ADR-014 §8 names the split honestly: the host, the tailnet and the scoped deploy keys
# are operator actions. This script does the part that is mechanical and repeatable — the
# runner account, the workspace and ledger directories, the hardened unit, the credential
# file's permissions — and it names, without stubbing, the three things it cannot do:
#
#   1. the VPS itself (operator buys it)
#   2. the Tailscale network (operator joins the host to their tailnet)
#   3. the scoped deploy keys / model credentials (operator places them in the
#      credential file this script creates the empty shell of, mode 600)
#
# ## What it will not do
#
# - It will not run as anything but root. The runner account and the /etc paths need it.
# - It will not write a credential value. It creates the file empty, mode 600, owner root,
#   and prints what the operator must put in it. A script that fills in a secret it was
#   given on a command line has leaked it into shell history and the process table.
# - It will not enable or start the service if the preflight fails. A service that starts
#   on a host that cannot sandbox is a service that will fail mid-run, and ADR-014 §5 says
#   absence is a refusal.
#
# Usage (as root, on the operator's Linux host):
#   bash software_factory/host/provision-executor-host.sh
#
# Idempotent: re-running it re-installs the unit and fixes permissions, and does not
# duplicate the runner or wipe a credential file that already has content.
set -euo pipefail

RUNNER_USER="${FACTORY_RUNNER_USER:-runner}"
RUNNER_HOME="${FACTORY_RUNNER_HOME:-/home/$RUNNER_USER}"
REPO_DIR="${FACTORY_REPO_DIR:-$RUNNER_HOME/software-factory}"
WORKSPACE="${FACTORY_WORKSPACE_ROOT:-$RUNNER_HOME/workspace}"
DATA_DIR="${FACTORY_DATA_DIR:-$RUNNER_HOME/.factory-data}"
SECRETS="${FACTORY_HOST_SECRETS_FILE:-/etc/software-factory/secrets.env}"
UNIT_NAME="software-factory-executor.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '  %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

# ── 1. Preconditions ───────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "run this as root: it creates the '$RUNNER_USER' account and installs a systemd unit"
command -v systemd-analyze >/dev/null 2>&1 || die "systemd is required (ADR-014 §6); this host does not appear to be systemd-managed"
[ -d "$HERE" ] || die "cannot find the host artifacts next to this script"

echo "═══ Software Factory executor-host provisioning (ADR-014) ═══"
say "runner:   $RUNNER_USER (home $RUNNER_HOME)"
say "repo:     $REPO_DIR"
say "workspace:$WORKSPACE"
say "ledger:   $DATA_DIR"
say "creds:    $SECRETS"

# ── 2. The runner account (ADR-014 §2) ─────────────────────────────────────
if id "$RUNNER_USER" >/dev/null 2>&1; then
  say "user '$RUNNER_USER' already exists"
else
  useradd --create-home --shell /bin/bash "$RUNNER_USER"
  say "created user '$RUNNER_USER'"
fi
if id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qxE 'sudo|wheel|root'; then
  die "'$RUNNER_USER' is in a privileged group; ADR-014 §2 requires an unprivileged runner. Remove it from sudo/wheel and re-run."
fi
say "runner is unprivileged (groups: $(id -nG "$RUNNER_USER"))"

# ── 3. Directories the loop may write (ADR-014 §6, NC-2) ───────────────────
install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 755 "$REPO_DIR" "$WORKSPACE" "$DATA_DIR"
say "workspace and ledger directories owned by $RUNNER_USER"

# ── 4. bubblewrap (ADR-014 §5: absence is a refusal, not a downgrade) ──────
if ! command -v bwrap >/dev/null 2>&1; then
  warn "bubblewrap is not installed. The loop will refuse to run sandboxed work here."
  warn "install it now: apt-get install -y bubblewrap   (or your distribution's equivalent)"
else
  say "bubblewrap present: $(command -v bwrap)"
fi

# ── 5. The credential file (ADR-014 §3) — created empty, never filled ──────
install -d -o root -g root -m 755 "$(dirname "$SECRETS")"
if [ -s "$SECRETS" ]; then
  say "credential file already has content; leaving it untouched"
else
  umask 077
  : > "$SECRETS"
  say "created an EMPTY credential file at $SECRETS (mode 600, owner root)"
fi
chown root:root "$SECRETS"; chmod 600 "$SECRETS"

# ── 6. The hardened unit (ADR-014 §6) ──────────────────────────────────────
UNIT_SRC="$HERE/$UNIT_NAME"
[ -f "$UNIT_SRC" ] || die "unit file missing: $UNIT_SRC"
install -m 644 -o root -g root "$UNIT_SRC" "/etc/systemd/system/$UNIT_NAME"
systemctl daemon-reload
say "installed /etc/systemd/system/$UNIT_NAME"

# ── 7. Refuse to bless a host the preflight rejects (ADR-014 §5) ───────────
# The preflight re-reads the unit, checks bubblewrap, the bind, the runner and the
# credential file. If it fails, the service is NOT enabled: starting on a host that
# cannot sandbox is the failure ADR-014 exists to prevent.
REPO_COPY="$REPO_DIR"
if [ ! -f "$REPO_COPY/scripts/verify-host.ts" ]; then
  # The repository may not be cloned yet; fall back to the copy next to this script.
  REPO_COPY="$(cd "$HERE/../.." && pwd)"
fi
if command -v node >/dev/null 2>&1 && [ -f "$REPO_COPY/scripts/verify-host.ts" ]; then
  echo
  say "running the host preflight before enabling the service…"
  if (cd "$REPO_COPY" && FACTORY_RUNNER_USER="$RUNNER_USER" FACTORY_WORKSPACE_ROOT="$WORKSPACE" FACTORY_DATA_DIR="$DATA_DIR" FACTORY_HOST_SECRETS_FILE="$SECRETS" npx --no-install tsx scripts/verify-host.ts); then
    systemctl enable "$UNIT_NAME"
    say "preflight passed; service enabled (start it with: systemctl start $UNIT_NAME)"
  else
    warn "preflight FAILED; the service is NOT enabled."
    warn "fix every failure above, then re-run this script (it is idempotent)."
    exit 1
  fi
else
  warn "node/tsx not available here; the preflight was NOT run and the service was NOT enabled."
  warn "install node, clone the repository to $REPO_DIR, then run: npx tsx scripts/verify-host.ts"
  warn "only after it passes: systemctl enable --now $UNIT_NAME"
fi

# ── 8. What this script cannot do (ADR-014 §8) — named, not stubbed ────────
cat <<EOF

═══ Operator actions still required (ADR-014 §8 — named, not automated) ═══

  1. THE HOST.   This script assumes a Linux VPS you own. It did not create it.
  2. THE TAILNET. Join this host to your Tailscale network and serve the loopback API
                 over the tailnet, for example:
                     tailscale serve --bg --https=443 http://127.0.0.1:3000
                 The service binds 127.0.0.1 (set FACTORY_BIND_HOST in $SECRETS);
                 without the tailnet it is unreachable by design, which is ADR-014 §4.
  3. THE CREDENTIALS. Edit $SECRETS (mode 600, root) and set, at minimum:
                     FACTORY_BIND_HOST=127.0.0.1
                     FACTORY_API_KEY=<a long random key you generate>
                     FACTORY_TENANT_CREDENTIALS=<tenantId:credential,...>
                     FACTORY_MODEL_ALLOWED_HOSTS=<your model provider hosts>
                 Never commit these. The file is readable only by root; systemd grants
                 the variables to the service; the runner cannot read the file.

Then run the preflight and start the service:

     cd $REPO_DIR && npx tsx scripts/verify-host.ts
     systemctl start $UNIT_NAME

And prove the reboot drill (ADR-014 §7) before trusting an unattended run:

     kill -9 \$(systemctl show -p MainPID --value $UNIT_NAME)   # simulate a crash
     npx tsx scripts/run-factory-loop.ts --repo <repo> --task <task.md> --resume <runId>
EOF
