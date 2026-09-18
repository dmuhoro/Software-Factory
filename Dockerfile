FROM oven/bun:1.2.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.2.5-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup --system --gid 10001 factory && adduser --system --uid 10001 --ingroup factory factory
COPY --from=build --chown=factory:factory /app/dist ./dist
COPY --from=build --chown=factory:factory /app/package.json ./package.json
COPY --from=build --chown=factory:factory /app/node_modules ./node_modules
USER factory
EXPOSE 3000
CMD ["bun", "dist/server.cjs"]
