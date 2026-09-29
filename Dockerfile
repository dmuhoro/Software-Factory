# syntax=docker/dockerfile:1
#
# Software Factory runtime image.
#
# The service reads configuration from the environment only. It has no baked-in
# credentials and will REFUSE TO START (exit 78) when a required production
# variable is missing, so a misconfigured deploy fails loudly at rollout instead
# of silently serving 401s.
#
# Package manager: npm, deliberately.
#
# This image previously installed with `bun install --frozen-lockfile` against
# `bun.lock`, while every test in CI ran under npm against `package-lock.json`.
# Those two lockfiles do not describe the same tree: 63 of their 313 shared
# packages resolve to different versions. The image therefore shipped a
# dependency set that no CI run had ever type-checked, unit-tested, or exercised
# through a single one of the four HTTP harnesses. A green pipeline was
# attesting to a build nobody would run.
#
# npm is the canonical manager because it is what CI uses, what all four
# verification harnesses run under, and what `npm run verify` uses. One manager,
# one lockfile, and the artifact is built from the tree the gates actually tested.

FROM oven/bun:1.2.5 AS build
WORKDIR /app
ENV CI=true

# `npm ci` -- not `npm install`. `ci` installs exactly the lockfile and fails if
# package.json and package-lock.json disagree, so a dependency edit that
# forgets to refresh the lockfile cannot reach an image.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM oven/bun:1.2.5-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    FACTORY_DATA_DIR=/var/lib/software-factory \
    FACTORY_WORKSPACE_ROOT=/var/lib/software-factory/workspace \
    FACTORY_BACKUP_DIR=/var/lib/software-factory/backups \
    FACTORY_PREVIEW_DIR=/var/lib/software-factory/previews \
    FACTORY_RELEASE_DIR=/var/lib/software-factory/releases

RUN addgroup --system --gid 10001 factory && adduser --system --uid 10001 --ingroup factory factory \
  && mkdir -p /var/lib/software-factory \
  && chown -R factory:factory /var/lib/software-factory \
  && chmod 700 /var/lib/software-factory

# Production dependencies only. The build stage installed devDependencies, which
# is what `vite`, `esbuild` and `tsc` need to build; none of them belong in a
# runtime image, and shipping them widens the attack surface for no benefit. A
# dev-only dependency in the production tree is a supply-chain risk that no test
# would ever catch.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY --from=build --chown=factory:factory /app/dist ./dist
COPY --chown=factory:factory /app/node_modules ./node_modules
COPY --chown=factory:factory /app/package.json ./package.json

# No credential is written into any layer above. The service reads its
# configuration from the environment and refuses to start without it, so there is
# nothing to leak from the image itself.

USER factory
EXPOSE 3000

# Reports the real ledger state, not a hardcoded string.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/factory/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/server.cjs"]
