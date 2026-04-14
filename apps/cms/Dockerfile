# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat vips-dev build-base python3
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/cms/package.json ./apps/cms/
RUN pnpm install --filter @sinnlos/cms... --frozen-lockfile=false

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/cms/node_modules ./apps/cms/node_modules
COPY apps/cms ./apps/cms
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
WORKDIR /app/apps/cms
RUN pnpm build

FROM node:20-alpine AS runner
RUN apk add --no-cache vips-dev
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app
WORKDIR /app/apps/cms
EXPOSE 1337
CMD ["pnpm", "start"]
