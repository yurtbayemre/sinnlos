# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS base
RUN apk add --no-cache libc6-compat vips-dev build-base python3
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
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runner
RUN apk add --no-cache vips-dev && corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app /app
WORKDIR /app/apps/cms
USER node
EXPOSE 1337
CMD ["pnpm", "start"]
