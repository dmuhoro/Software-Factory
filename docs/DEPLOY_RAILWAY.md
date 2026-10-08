# Deploying Software Factory to Railway

Software Factory is a **single-process, single-writer** service. Railway can host it, but the
deployment contract is narrower than a stateless web app's. This document is the contract.

## The three hard constraints

1. **One replica, always.** The durable ledger takes a cross-process writer lock
   (`src/services/durableStore.ts`). A second replica pointed at the same volume is refused at
   startup with exit code 75. `railway.json` pins `numReplicas: 1`. Do not scale horizontally
   until the storage backend is migrated (see ADR-009); the service will refuse rather than
   corrupt the ledger.

2. **A persistent volume.** The ledger, loop reports, previews and releases live under
   `FACTORY_DATA_DIR`. Without a volume they are lost on every deploy. Mount a volume at
   `/var/lib/software-factory`, which is where the image already points its data, workspace,
   backup, preview and release directories.

3. **A hosted model provider.** The default cheap tier is a local Ollama model
   (`doctrine/agents/models.json`), which does not exist in a Railway container. Register an
   OpenAI-compatible provider for the tenant before the first run (see "Registering a provider").

## Required environment variables

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `FACTORY_API_KEY` | `openssl rand -hex 32` — the platform/operator credential |
| `FACTORY_TENANT_CREDENTIALS` | `tenantId:<openssl rand -hex 32>` — a per-tenant credential |
| `STORAGE_BACKEND` | `local` |
| `FACTORY_DATA_DIR` | `/var/lib/software-factory` (already set in the image) |
| `FACTORY_WORKSPACE_ROOT` | `/var/lib/software-factory/workspace` (already set in the image) |
| `FACTORY_ALLOWED_MODEL_HOSTS` | the provider host(s), comma-separated, e.g. `api.openai.com` |
| `ALLOW_INSECURE_LOCAL` | **must not be set.** Setting it in production is a startup failure. |

The image refuses to start (exit 78) when a required production variable is missing or is a known
placeholder, so a misconfigured deploy fails at rollout instead of serving 401s.

## Deploy

1. Create a Railway project from this repository. `railway.json` selects the `Dockerfile` builder.
2. Add the volume: mount a volume at `/var/lib/software-factory`.
3. Set the environment variables above.
4. Deploy. Railway polls `/api/factory/health` and restarts on failure.
5. Confirm the live contract (from a machine that is **not** the server):
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/factory/health` → `200`
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/loop/runs` → `401` (no credential)
   - `curl -sS -H "Authorization: Bearer $FACTORY_API_KEY" https://<host>/api/loop/runs` → `200`

## Registering a provider

Provider registration is a tenant-scoped API call, not a config file:

```
curl -sS -X POST https://<host>/api/agents/providers \
  -H "X-Api-Key: <tenant credential>" -H 'Content-Type: application/json' \
  -d '{"tenantId":"<tenant>","id":"openai","kind":"openai","baseUrl":"https://api.openai.com/v1","modelIds":["gpt-4o-mini"],"secretRef":"OPENAI_API_KEY"}'
```

`secretRef` names an environment variable the process resolves at call time; the secret itself is
never stored in the ledger. The host must also be listed in `FACTORY_ALLOWED_MODEL_HOSTS`.

## What this deployment does and does not support

- **Supported:** submitting, listing and streaming task-run records over the authenticated HTTP
  API; running the loop against a git repository that exists on the volume under
  `FACTORY_WORKSPACE_ROOT`.
- **Not supported yet:** running verification commands that require `bwrap` inside the container.
  The loop refuses to run a command it cannot sandbox rather than running it bare; container-level
  execution isolation is tracked as its own change and is not silently assumed here.