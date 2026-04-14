# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --filter @sinnlos/web... --frozen-lockfile=false

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
WORKDIR /app/apps/web
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next/standalone /app
COPY --from=builder /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=builder /app/apps/web/public /app/apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
