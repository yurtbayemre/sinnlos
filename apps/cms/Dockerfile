# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS base
# build-base + python3: node-gyp fallback for better-sqlite3 when its prebuilt
# binary cannot be fetched. No system libvips: sharp 0.35 has no install
# script and always loads its bundled @img/sharp-libvips-linuxmusl-x64.
RUN apk add --no-cache libc6-compat build-base python3
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/cms/package.json ./apps/cms/
RUN pnpm install --filter @sinnlos/cms... --frozen-lockfile

FROM base AS builder
COPY apps/cms ./apps/cms
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/cms/node_modules ./apps/cms/node_modules
WORKDIR /app/apps/cms
RUN pnpm build

# NOTE: keep the full node_modules tree in the runtime image — Strapi's
# admin/runtime resolves packages that a --prod re-install would strip.
# No pnpm/corepack here: the container starts Strapi directly (CMD below).
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runner
WORKDIR /app
ENV NODE_ENV=production
# Datetime contract: the cms runs in UTC. Business dates use APP_TIME_ZONE;
# a boot that creates or changes the schema refuses any other process zone.
ENV TZ=UTC
COPY --from=builder --chown=node:node /app /app
WORKDIR /app/apps/cms
USER node
EXPOSE 1337
# Strapi's own bin (the pnpm shim that `pnpm start` ran; it execs node), not
# `pnpm start`: corepack had prepared pnpm for root only, so every start as
# `node` downloaded pnpm from registry.npmjs.org, and a restart or rollback
# failed while the registry was unreachable. Strapi handles SIGTERM itself
# (graceful shutdown); compose adds `init: true` for signal forwarding and
# zombie reaping.
CMD ["node_modules/.bin/strapi", "start"]
