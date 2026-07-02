# FX Swing-Trading Platform

AI-powered FX swing-trading platform (H1 → D1) — deterministic quant core, LangGraph.js
multi-agent confirmation layer, non-LLM risk gate with final authority. See
[`development-plan/FX_PRD.md`](development-plan/FX_PRD.md).

> Invite-only, own-broker-account-only, personal/research use. CFDs are high-risk
> leveraged products. Not financial advice.

## Prerequisites

- Node 22 LTS (`.nvmrc`)
- pnpm 9 via `corepack enable`
- Docker Desktop (from Step 1.2 onward)

## Quickstart

```bash
corepack enable
pnpm install
cp .env.example .env        # then fill in values
pnpm build                  # turbo: build all workspaces
pnpm test                   # vitest across workspaces
pnpm --filter @fx/dashboard dev   # dashboard on :3000
pnpm --filter @fx/node-api dev    # api on :4000
```

## Workspaces

| Path | Package | Purpose |
|---|---|---|
| `apps/dashboard` | `@fx/dashboard` | Next.js 16 operator dashboard |
| `apis/node-api` | `@fx/node-api` | Fastify modular monolith (Phase 1: minimal boot) |
| `packages/types` | `@fx/types` | Zod 4 contracts — source of truth; JSON Schema emit for Python |
| `packages/api-client` | `@fx/api-client` | Typed, Zod-validated fetch client |
| `packages/auth-client` | `@fx/auth-client` | `useSession`, `useStepUp2FA`, `requireAuth` |
| `packages/tsconfig` | `@fx/tsconfig` | Shared TS configs |
| `workers/` | — | BullMQ workers (Phase 2+) |

`TRADING_MODE` (`backtest | paper | live`) drives one identical code path in every mode.
