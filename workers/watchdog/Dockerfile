FROM node:22-alpine AS build
WORKDIR /app
COPY workers/watchdog/package.json workers/watchdog/tsconfig.json ./
RUN corepack enable && npm install -g pnpm@9
COPY workers/watchdog/ ./
RUN pnpm install && pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "dist/index.js"]
