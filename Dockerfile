# syntax=docker/dockerfile:1
#
# Software Factory runtime image.
#
# The service reads configuration from the environment only. It has no baked-in
# credentials and will REFUSE TO START (exit 78) when a required production
# variable is missing, so a misconfigured deploy fails loudly at rollout instead
# of silently serving 401s.
#
# Runtime and package manager: Node.js and npm, deliberately the same one.
#
# This image had two problems that only a build could reveal.
#
# First, it installed with `bun install --frozen-lockfile` against `bun.lock`, while every
# test in CI ran under npm against `package-lock.json`. Those lockfiles do not describe the
# same tree: 63 of their 313 shared packages resolve to different versions. The image
# therefore shipped a dependency set that no CI run had ever type-checked, unit-tested, or
# driven through a single one of the four HTTP harnesses. The pipeline was green about a
# build nobody deployed.
#
# Second, switching the install to `npm ci` on the `oven/bun` base image failed
# immediately: that image ships a `node` shim that points at `bun`, and no npm at all, so
# the step died with `npm: not found`. The previous Dockerfile had never been built, which
# is why neither fact was known. The base is now `node:22-slim`, where the package manager
# that installs is the runtime that executes.
#
# The service has no Bun-specific APIs, and the build already targets `--platform=node`, so
# running the bundle under Node is the intended configuration rather than a workaround.
#
# `npm ci`, not `npm install`: it installs exactly the lockfile and fails if package.json
# and package-lock.json have drifted, so a dependency edit that forgets to refresh the
# lockfile cannot reach an image.

FROM node:22-slim AS build
WORKDIR /app
ENV CI=true

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    FACTORY_DATA_DIR=/var/lib/software-factory \
    FACTORY_WORKSPACE_ROOT=/var/lib/software-factory/workspace \
    FACTORY_BACKUP_DIR=/var/lib/software-factory/backups \
    FACTORY_PREVIEW_DIR=/var/lib/software-factory/previews \
    FACTORY_RELEASE_DIR=/var/lib/software-factory/releases

RUN groupadd --system --gid 10001 factory \
  && useradd --system --uid 10001 --gid 10001 --home-dir /var/lib/software-factory factory \
  && mkdir -p /var/lib/software-factory \
  && chown -R factory:factory /var/lib/software-factory \
  && chmod 700 /var/lib/software-factory

# Production dependencies only. The build stage installed devDependencies, which is what
# vite, esbuild and tsc need to build; none of them belong in a runtime image, and shipping
# them widens the attack surface for no benefit. A dev-only dependency in the production
# tree is a supply-chain risk that no test would ever catch.
#
# The runtime stage installs its own production tree rather than copying the build stage's
# `node_modules` across. That is deliberate on two counts. It makes the runtime dependency
# set exactly `npm ci --omit=dev` of the committed lockfile, rather than "the build's tree
# minus whatever was pruned", which is a subtly different thing that drifts. And it removes
# a `COPY --from=build` that failed on the first build attempt, because `.dockerignore`
# excludes `node_modules` from the context and the copy was being resolved against it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf /root/.npm

# `dist` is the only thing that has to come from the build stage. `package.json`,
# `package-lock.json` and `node_modules` are already in this stage: the manifest pair was
# copied in above so `npm ci --omit=dev` could install from it, and that install is the
# runtime dependency tree. Two later `COPY` lines that re-fetched the manifest and the
# dependencies were both redundant, and the first one to be reached failed the build.
COPY --from=build --chown=factory:factory /app/dist ./dist

# No credential is written into any layer above. The service reads its configuration from
# the environment and refuses to start without it, so there is nothing to leak from the
# image itself. `scripts/verify-image.sh` checks that claim against the built artifact
# rather than trusting this comment.

USER factory
EXPOSE 3000

# Reports the real ledger state, not a hardcoded string.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/factory/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
