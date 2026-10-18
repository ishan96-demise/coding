FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.5 --activate

FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN pnpm build

FROM base AS production-dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN addgroup --system --gid 1001 nextjs && adduser --system --uid 1001 nextjs
COPY --from=production-dependencies --chown=nextjs:nextjs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nextjs /app/.next ./.next
COPY --from=builder --chown=nextjs:nextjs /app/package.json ./package.json
USER nextjs
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
