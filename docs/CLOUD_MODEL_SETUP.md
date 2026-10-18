# Cloud Model API Key Setup — Server-Side Directions

This document tells an operator how to mount live cloud-model API keys server-side so
the Software Factory unattended loop can dial real models. It is written against the
code, not the ambition: every step names the file or environment variable that makes
it true.

## Prerequisites

- You have an account with a model provider (DeepSeek, Together, Mistral, NVIDIA, OpenAI, etc.)
- You can create API keys in that provider's console
- You have shell access to the server that runs the Software Factory

## Step 1 — Create provider API keys

Create one API key per provider you intend to use. Each key is a plaintext secret:
never commit it, never print it, never send it over chat.

| Provider | Key created in | Example env var name |
|----------|---------------|---------------------|
| DeepSeek | platform.deepseek.com | `DEEPSEEK_API_KEY` |
| Together | api.together.xyz | `TOGETHER_API_KEY` |
| Mistral | console.mistral.ai | `MISTRAL_API_KEY` |
| NVIDIA | build.nvidia.com | `NVIDIA_API_KEY` |
| OpenAI | platform.openai.com | `OPENAI_API_KEY` |

## Step 2 — Mount keys server-side

Keys are resolved through `FACTORY_ALLOWED_SECRET_REFS`, which lists the *environment
variable names* the factory may resolve. The values themselves live in the server's
environment — never in a committed `.env` file.

### Option A: systemd service file (recommended for production)

```ini
# /etc/systemd/system/software-factory.service
[Service]
Environment="FACTORY_ALLOWED_SECRET_REFS=DEEPSEEK_API_KEY,TOGETHER_API_KEY,MISTRAL_API_KEY,NVIDIA_API_KEY,OPENAI_API_KEY"
Environment="FACTORY_MODEL_ALLOWED_HOSTS=api.deepseek.com,api.together.xyz,api.mistral.ai,integrate.api.nvidia.com,api.openai.com"
Environment="DEEPSEEK_API_KEY=<actual-deepseek-key>"
Environment="TOGETHER_API_KEY=<actual-together-key>"
Environment="MISTRAL_API_KEY=<actual-mistral-key>"
Environment="NVIDIA_API_KEY=<actual-nvidia-key>"
Environment="OPENAI_API_KEY=<actual-openai-key>"
```

The `.env` file is gitignored and must not contain real keys. The systemd unit file
is also not committed to the repository.

### Option B: secret manager (Kubernetes, AWS Secrets Manager, etc.)

Mount each key as an environment variable in the container. The variable *name* must
appear in `FACTORY_ALLOWED_SECRET_REFS`, and the host must appear in
`FACTORY_MODEL_ALLOWED_HOSTS`.

## Step 3 — Register providers

`npm run register:model-providers` reads provider configuration from the environment
and registers each one through `FrontierModelService.register()`, which validates:

- The base URL hostname against `FACTORY_MODEL_ALLOWED_HOSTS` — fail closed if not permitted
- The secret reference against `FACTORY_ALLOWED_SECRET_REFS` — fail closed if not permitted or unmounted

Example `.env` (server-side only, never committed):

```
FACTORY_MODEL_PROVIDERS=deepseek,together,mistral,nvidia,openai

FACTORY_ALLOWED_SECRET_REFS=DEEPSEEK_API_KEY,TOGETHER_API_KEY,MISTRAL_API_KEY,NVIDIA_API_KEY,OPENAI_API_KEY
FACTORY_MODEL_ALLOWED_HOSTS=api.deepseek.com,api.together.xyz,api.mistral.ai,integrate.api.nvidia.com,api.openai.com

DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_SECRET_REF=DEEPSEEK_API_KEY
DEEPSEEK_MODEL_IDS=deepseek-chat,deepseek-coder

TOGETHER_BASE_URL=https://api.together.xyz/v1
TOGETHER_SECRET_REF=TOGETHER_API_KEY
TOGETHER_MODEL_IDS=Qwen/Qwen2.5-Coder-32B-Instruct

MISTRAL_BASE_URL=https://api.mistral.ai/v1
MISTRAL_SECRET_REF=MISTRAL_API_KEY
MISTRAL_MODEL_IDS=mistral-large-latest

NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_SECRET_REF=NVIDIA_API_KEY
NVIDIA_MODEL_IDS=nemotron-3.5-super-vl-120b-a12b

OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_SECRET_REF=OPENAI_API_KEY
OPENAI_MODEL_IDS=gpt-5-mini,gpt-5
```

Each provider `{ID}` reads:
- `{ID}_BASE_URL` — required for remote kinds
- `{ID}_SECRET_REF` — the env var *name* holding the key (must be in `FACTORY_ALLOWED_SECRET_REFS`)
- `{ID}_MODEL_IDS` — comma-separated model IDs the provider serves
- `{ID}_KIND` — `openai-compatible` | `gemini-native` | `local` (default: `openai-compatible`)

## Step 4 — Assign roles to providers

Role-to-model assignment lives in `doctrine/agents/models.json`. Roles map to tiers,
tiers map to `providerId/model`:

```json
{
  "tiers": {
    "cheap": { "default": "deepseek/deepseek-coder" },
    "frontier": { "default": "deepseek/deepseek-chat" }
  },
  "roles": {
    "architect": { "tier": "frontier" },
    "implementer": { "tier": "cheap" },
    "reviewer": { "tier": "frontier" }
  }
}
```

Overrides (highest precedence first):

```bash
# One role
FACTORY_MODEL_ROLE_IMPLEMENTER=deepseek/deepseek-coder

# Whole tier
FACTORY_MODEL_TIER_FRONTIER=deepseek/deepseek-chat

# Per task document
models.implementer: deepseek/deepseek-coder
```

## Step 5 — Verify registration

```bash
npm run register:model-providers
```

Expected output: each provider is `registered` with its kind, base URL, and model IDs.
If any provider fails validation, the script exits non-zero and names the failure.

Then verify no socket was opened at registration (registration only validates config;
DNS resolution happens at request time):

```bash
npm run verify:pr-config
```

## Step 6 — Run the loop

With providers registered and keys mounted, run the unattended loop:

```bash
npm run factory:run
```

The loop dials the registered cloud models through the egress guard. Every model call
is subject to `FACTORY_MODEL_ALLOWED_HOSTS` and `FACTORY_ALLOWED_SECRET_REFS` — a key
mounted but not allowlisted is refused, never sent.

## What remains blocked

Until live keys are mounted, every model request fails closed at the socket boundary.
The following layers cannot be exercised without them:

| Layer | Objective | Blocker |
|-------|-----------|---------|
| Layer 2 | Bench adoption decision (`bench:skills --model provider/model`) | Live model API key |
| Layer 3 | Production trial (≥30 adjudicated units, `trial:report`) | Live model API key + Layer 2 |
| Layer 4 | Flip `unrelatedWrites.enforce` to blocking | Trial data from Layer 3 |
| Layer 5 | Production deployment (`verify:full`, `verify:deploy`) | All layers above |

Owner: operator. This repository does not ship API keys.

## Security rules

1. **Never commit a key.** `.env` is gitignored. A key in a commit is burned: rotate it.
2. **Never print a key.** The egress guard resolves keys by name; the value is never logged.
3. **Allowlist before mounting.** Add the host to `FACTORY_MODEL_ALLOWED_HOSTS` and the
   ref name to `FACTORY_ALLOWED_SECRET_REFS` before mounting the value. A mounted key
   without an allowlist entry is a configuration error, not a free pass.
4. **One key per provider.** Do not share keys across providers or tenants.
