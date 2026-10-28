# Pi cost dashboard, containerized.
#
# Two stages: build the React app with Vite, then run only the Express server. The build
# stage installs a C++ toolchain because better-sqlite3 compiles a native module when no
# prebuilt binary matches the platform; after the Vite build, dev dependencies are pruned
# so the runtime image carries only what the server imports.

FROM node:24-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Dependency layer first: editing app code does not invalidate `npm ci`.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/server ./server
COPY --chown=node:node --from=build /app/web/dist ./web/dist

# Where the SQLite file lives. compose.yml mounts a named volume here.
RUN mkdir -p /app/data && chown node:node /app/data

# The scanner's directory when this deployment is push-fed. Deliberately empty: point
# PI_COST_SESSIONS_DIR at a mounted Pi sessions directory to scan local history instead.
RUN mkdir -p /app/no-sessions && chown node:node /app/no-sessions

USER node
EXPOSE 4870

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4870/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Migrate runs on start so the schema exists before the first request. Backfill is a no-op
# when PI_COST_SESSIONS_DIR is empty, and warms the scan cache when it is not.
CMD ["sh", "-c", "node server/cli-migrate.js && node server/cli-backfill.js && exec node server/index.js"]
