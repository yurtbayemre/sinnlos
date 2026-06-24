# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --filter @sinnlos/web... --frozen-lockfile

FROM base AS builder
COPY apps/web ./apps/web
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
WORKDIR /app/apps/web
RUN pnpm build && mkdir -p public

FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone /app
COPY --from=builder --chown=node:node /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public /app/apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
