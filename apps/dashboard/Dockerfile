# BE-004 — Dashboard image (Next.js standalone output, monorepo-aware).
# Build context must be the repo root: docker build -f apps/dashboard/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @fx/dashboard build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output bundles node_modules + server.js, keyed by monorepo path.
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["node", "apps/dashboard/server.js"]
