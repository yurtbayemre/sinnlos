# syntax=docker/dockerfile:1
# The Node base of every stage, pinned by digest in this one place: `base`
# (and so deps and builder) and `runner` both start FROM this stage. A stage
# alias rather than a build ARG, because Dependabot's docker updater reads
# FROM lines only: a digest in an ARG default would never be bumped again.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS node-base

FROM node-base AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
# pnpm = package.json packageManager (dependency build scripts: see the root
# package.json's pnpm.onlyBuiltDependencies).
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
# The web depends on the workspace package @sinnlos/domain (SH01).
COPY packages/domain/package.json ./packages/domain/
RUN pnpm install --filter @sinnlos/web... --frozen-lockfile
# Third-party notices (v0.26, M1): the production dependencies, the ones the
# standalone output bundles or traces.
COPY scripts/third-party-notices.mjs ./scripts/
RUN pnpm licenses list --json --prod --filter @sinnlos/web... > /tmp/licenses.json \
  && node scripts/third-party-notices.mjs /app/THIRD_PARTY_NOTICES.txt < /tmp/licenses.json

FROM base AS builder
COPY apps/web ./apps/web
COPY packages/domain ./packages/domain
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
# dist/esm of @sinnlos/domain: next build bundles it into the standalone
# output, so the runtime stage needs nothing of the package.
RUN pnpm --filter @sinnlos/domain build
WORKDIR /app/apps/web
RUN pnpm build && mkdir -p public

FROM node-base AS runner
# D-SESSION-01: this web keeps the Strapi JWT server-side (never on
# /api/auth/session). infra/deploy.sh demands a JWT_SECRET rotation when the
# running web lacks this label, i.e. when it still exposed the JWTs.
LABEL org.sinnlos.strapi-jwt="server-only"
# Datetime contract, phase 2: this web renders every date with an explicit
# zone (APP_TIME_ZONE), so it runs in UTC like the cms. The label tells
# infra/deploy.sh's rollback hint that a :rollback web image with it needs no
# legacy-zone override; one without it predates the port and refuses to
# start in UTC (infra/docker-compose.web-legacy-tz.yml).
LABEL org.sinnlos.datetime="zone-explicit"
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=UTC
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone /app
COPY --from=builder --chown=node:node /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public /app/apps/web/public
# Served at /THIRD_PARTY_NOTICES.txt (proxy.ts PUBLIC_FILES) and kept at /app.
COPY --from=deps /app/THIRD_PARTY_NOTICES.txt /app/apps/web/public/THIRD_PARTY_NOTICES.txt
COPY --from=deps /app/THIRD_PARTY_NOTICES.txt /app/THIRD_PARTY_NOTICES.txt
COPY LICENSE /app/LICENSE
# v0.26 release identity, last so the layers above keep their cache:
# infra/deploy.sh and the release workflow pass both build args.
ARG SINNLOS_VERSION=unknown
ARG SINNLOS_REVISION=unknown
ENV SINNLOS_REVISION=$SINNLOS_REVISION
LABEL org.opencontainers.image.version=$SINNLOS_VERSION
LABEL org.opencontainers.image.revision=$SINNLOS_REVISION
LABEL org.opencontainers.image.source="https://github.com/yurtbayemre/sinnlos"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
