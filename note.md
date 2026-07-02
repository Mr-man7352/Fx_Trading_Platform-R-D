corepack enable
pnpm install
cp .env.example .env
pnpm build && pnpm test
pnpm --filter @fx/node-api dev    # then open http://localhost:4000/healthz
pnpm --filter @fx/dashboard dev   # then open http://localhost:3000