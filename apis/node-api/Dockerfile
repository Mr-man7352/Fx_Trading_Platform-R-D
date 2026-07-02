# BE-001 — Node API image (monorepo-aware via pnpm deploy)
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @fx/types build && pnpm --filter @fx/node-api build
RUN pnpm --filter @fx/node-api deploy --prod /app

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
COPY --from=build /repo/apis/node-api/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
