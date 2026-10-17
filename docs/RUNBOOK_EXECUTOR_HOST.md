# Runbook — the executor host (ADR-014)

This is the operator's procedure for putting the unattended loop on its own Linux host and
keeping it there. It is a runbook, not a design note: every step is a command you can run,
and every gate is one you can watch pass or fail. The decisions it serves are in
`docs/adr/ADR-014-executor-host-operator-owned-private.md`; this document does not restate
them, it tells you how to satisfy them.

The split is honest, and ADR-014 §8 names it: **three things only you can do**, and the rest
is mechanical and scripted.

| Who | What |
| --- | --- |
| You | Buy the host, join it to your tailnet, place the credentials |
| The scripts | The runner account, the directories, the hardened unit, the permissions, the checks |

## 0. What "done" looks like

A host is ready when these two commands are green, in this order:

    npx tsx scripts/verify-host.ts --record
    bash scripts/verify-image.sh node

The first proves the *host* (bubblewrap can sandbox, the listener is private, the runner is
unprivileged, the credentials are unreadable, the unit is hardened, the ledger has one
writer). The second proves the *image* the host runs (it builds, it does not bake a
credential, it refuses to start unconfigured, and — the part this runbook exists for —
bubblewrap is present and can actually create a container as the unprivileged user).

`--record` writes what was checked to `docs/evidence/executor-host-<date>.md`. Keep that
file: "the host passed on this date" should be an artifact, not a recollection.

## 1. The host (operator action)

A Linux VPS you own, systemd-managed, on a private network you control. Nothing here
provisions the VPS. Confirm systemd is present before going further:

    systemd-analyze --version

## 2. The tailnet (operator action)

Join the host to your tailnet. The service binds loopback and you reach it over the tailnet;
a public bind is the exposure ADR-014 §4 exists to prevent and the preflight refuses it.

    tailscale up
    tailscale serve --bg --https=443 http://127.0.0.1:3000

## 3. Provision the host (scripted)

As root, from a clone of this repository:

    sudo bash deploy/host/provision-executor-host.sh

It creates the unprivileged `runner` account, the workspace and ledger directories, an
**empty** credential file at `/etc/software-factory/secrets.env` (mode 600, owner root), and
installs the hardened unit `deploy/host/software-factory-executor.service`. It is
idempotent: re-run it to re-install the unit and fix permissions.

It will **not** fill in a credential — a script that writes a secret handed to it on a
command line has already leaked it into the shell history and the process table. It will
**not** enable the service if the preflight fails: a service that starts on a host that
cannot sandbox is the failure ADR-014 exists to prevent.

## 4. The credentials (operator action)

Edit `/etc/software-factory/secrets.env` (mode 600, owner root) and set at least:

    FACTORY_BIND_HOST=127.0.0.1
    FACTORY_API_KEY=<a long random key you generate>
    FACTORY_TENANT_CREDENTIALS=<tenantId:credential,...>
    FACTORY_MODEL_ALLOWED_HOSTS=<your model provider hosts>

Never commit these. The file is readable only by root, systemd grants the variables to the
service, and the runner account cannot read it.

## 5. Bubblewrap (ADR-014 §5 — absence is a refusal)

The loop shells out to `bubblewrap` for every sandboxed verification command. There is no
downgrade: if the sandbox cannot start, the run refuses rather than running the command
unsandboxed.

    command -v bwrap || sudo apt-get install -y bubblewrap

The container image carries its own copy; on a bare host, install it here. The preflight in
step 6 fails if it is missing.

## 6. Prove it, and keep the proof

    npx tsx scripts/verify-host.ts --record

Green means the host is the host ADR-014 describes. On failure the same command exits
non-zero, prints a `fix:` line for each failure, and still writes the dated evidence file.

    cat docs/evidence/executor-host-$(date +%F).md

Then start the service:

    sudo systemctl enable --now software-factory-executor.service
    systemctl status software-factory-executor.service

## 7. Prove the reboot drill (ADR-014 §7)

Before you trust an unattended run, prove the loop survives a crash. Kill the service
outright and resume the run:

    sudo kill -9 $(systemctl show -p MainPID --value software-factory-executor.service)
    npx tsx scripts/run-factory-loop.ts --repo <repo> --task <task.md> --resume <runId>

The resumed run must pick up from its checkpoint, not restart from zero and not double-write
the ledger (ADR-014 §7, NC-2).

## 8. When something is wrong

| Symptom | First check |
| --- | --- |
| A run refuses "sandbox" the moment it starts | `npx tsx scripts/verify-host.ts` — the bubblewrap check names the cause |
| `/health` unreachable from your laptop | `tailscale serve status`; the bind is loopback by design |
| The service will not start after `systemctl start` | `journalctl -u software-factory-executor.service -n 50`; a missing variable is named |
| A second writer appears in the ledger | `systemctl status` — one instance, no clustering; the single-writer preflight check (NC-2) |
| The image builds but a run dies at the boundary | `bash scripts/verify-image.sh node` — the sandbox-runtime section reports the flags and the failure |

## 9. What this runbook does not cover

The API contract, the loop's own behaviour, and the product surface are in `README.md` and
the ADRs under `docs/adr/`. This document covers only the host the loop runs on and how to
prove it is safe before work is submitted to it.
