# syntax=docker/dockerfile:1

# The build output is plain JavaScript without native modules, so the build
# stage runs natively on the builder and only the thin runtime stages are
# per-platform: multi-arch images do not pay for QEMU during npm ci.

# ---------------------------------------------------------------- build
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------- tests (used by dev-compose.yml)
FROM build AS test
CMD ["npm", "test"]

# ---------------------------------------------------------------- fake Allure TestOps (used by dev-compose.yml)
FROM node:22-alpine AS mock
WORKDIR /app
COPY dev/mock-testops.mjs dev/
USER node
EXPOSE 9090
CMD ["node", "dev/mock-testops.mjs"]

# ---------------------------------------------------------------- production dependencies
FROM --platform=$BUILDPLATFORM build AS prod-deps
RUN npm prune --omit=dev

# ---------------------------------------------------------------- application (default target)
FROM node:22-alpine AS app
WORKDIR /app
# A cap on the JavaScript heap keeps long exports from holding on to memory
# they no longer use; raise it in compose if a container has more to give.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    NODE_OPTIONS=--max-old-space-size=1024
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "server/dist/index.js"]
