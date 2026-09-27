# syntax=docker/dockerfile:1
#
# Software Factory runtime image.
#
# The service reads configuration from the environment only. It has no baked-in
# credentials and will REFUSE TO START (exit 78) when a required production
# variable is missing, so a misconfigured deploy fails loudly at rollout instead
# of silently serving 401s.

FROM oven/bun:1.2.5 AS build
WORKDIR /app
ENV CI=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

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

COPY --from=build --chown=factory:factory /app/dist ./dist
COPY --from=build --chown=factory:factory /app/package.json ./package.json
COPY --from=build --chown=factory:factory /app/node_modules ./node_modules

USER factory
EXPOSE 3000

# Reports the real ledger state, not a hardcoded string.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/factory/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/server.cjs"]
