# Deploying Software Factory with Docker (self-host)

This is the **Docker route**: a single container that serves the API and the
built SPA, backed by a named volume so durable state survives restarts and
image upgrades. It is functionally equivalent to the Railway route — same
image, same entrypoint, same health check.

## What the compose file does

- Builds the production image from `Dockerfile` (multi-stage: Vite build + bundled Express server).
- Publishes the server on host port **8080** (container serves on 3000).
- Persists all runtime state under the named volume `sf-data` mounted at `/data`
  (durable store, backups, previews, releases, loop reports).
- Drops privileges: the entrypoint chowns `/data` only if the container started
  as root, then `exec`s the server as the unprivileged `factory` user.
- Health-checks `GET /api/factory/health`.

## Required configuration

Only one variable is an **error** if missing or left at its placeholder value:

| Variable | Meaning |
|---|---|
| `FACTORY_API_KEY` | Platform-operator API key. Must be a real secret, not the `.env.example` placeholder. |

Everything else is an optional enrichment (Appwrite persistence, Gemini,
tenant credentials). Absent means the system runs its honest fail-closed
defaults and reports `configuration: degraded` — it does **not** silently
pretend those integrations are live.

## First run

Create `.env.docker` (gitignored — never commit it) with a real operator key:

```sh
umask 077
printf 'FACTORY_API_KEY=%s\n' "$(openssl rand -hex 32)" > .env.docker
```

Then start the stack:

```sh
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:8080/api/factory/health | jq .
```

Expected: the container reports `healthy` and the health payload shows
`durableStore: healthy`.

## Prove durability (the whole point of the volume)

```sh
# 1. make a durable change (e.g. register a tenant / draft a goal) via the API, then
docker compose restart software-factory
# 2. the same change is still visible after restart -> the volume is working
```

## Upgrade

```sh
docker compose build --pull
docker compose up -d
```

The `sf-data` volume is preserved across rebuilds, so upgrades are not data-loss events.

## Stop / wipe

```sh
docker compose down            # stop, keep data
docker compose down -v         # stop and DELETE the sf-data volume (destructive)
```

## Secrets

`.env` and `.env.docker` are gitignored. Never put a live credential in
`docker-compose.yml`, in the `Dockerfile`, in a build arg, or in a commit.
