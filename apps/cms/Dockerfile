# syntax=docker/dockerfile:1
# The Node base of every stage, pinned by digest in this one place: `base`
# (and so deps and builder) and `runner` both start FROM this stage. A stage
# alias rather than a build ARG, because Dependabot's docker updater reads
# FROM lines only: a digest in an ARG default would never be bumped again.
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS node-base

FROM node-base AS base
# build-base + python3: node-gyp fallback for better-sqlite3 when its prebuilt
# binary cannot be fetched. No system libvips: sharp 0.35 has no install
# script and always loads its bundled @img/sharp-libvips-linuxmusl-x64.
RUN apk add --no-cache libc6-compat build-base python3
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/cms/package.json ./apps/cms/
# The cms depends on the workspace package @sinnlos/domain (SH01).
COPY packages/domain/package.json ./packages/domain/
RUN pnpm install --filter @sinnlos/cms... --frozen-lockfile

FROM base AS builder
COPY apps/cms ./apps/cms
COPY packages/domain ./packages/domain
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/cms/node_modules ./apps/cms/node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
# dist/cjs of @sinnlos/domain: the cms compile reads its .d.ts, the runtime
# requires it through apps/cms/node_modules/@sinnlos/domain (a symlink).
RUN pnpm --filter @sinnlos/domain build
WORKDIR /app/apps/cms
RUN pnpm build
# What `strapi start` reads besides node_modules, gathered for ONE runner
# layer (IN02): the compiled server and admin panel (dist), package.json,
# tsconfig.json (its presence and outDir make `strapi start` load dist, not
# the sources), favicon.png, the plain-JS user migrations (database/), the
# public dir with an empty uploads/ (the cms_uploads volume mounts there and
# takes its owner from the image), and the built @sinnlos/domain the
# node_modules symlink points at.
RUN mkdir -p /out/apps/cms /out/packages/domain \
  && cp -a package.json tsconfig.json favicon.png dist database public /out/apps/cms/ \
  && mkdir -p /out/apps/cms/public/uploads \
  && cp -a ../../packages/domain/package.json ../../packages/domain/dist /out/packages/domain/

# No pnpm here (corepack is not enabled): the container starts Strapi directly (CMD below).
FROM node-base AS runner
WORKDIR /app
ENV NODE_ENV=production
# Datetime contract: the cms runs in UTC. Business dates use APP_TIME_ZONE;
# a boot that creates or changes the schema refuses any other process zone.
ENV TZ=UTC
# Two layers (IN02). First the dependency tree, straight from the deps stage:
# it changes only with the lockfile, so a rebuild for a code change reuses
# the cached layer instead of writing (and a VPS keeping) a new copy of it.
# Keep the FULL tree: Strapi's admin/runtime resolves packages that a --prod
# re-install would strip.
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=deps --chown=node:node /app/apps/cms/node_modules /app/apps/cms/node_modules
# Then the app itself (see the builder's /out above).
COPY --from=builder --chown=node:node /out /app
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
