# FX Swing-Trading Platform

AI-powered FX swing-trading platform (H1 → D1) — deterministic quant core, LangGraph.js
multi-agent confirmation layer, non-LLM risk gate with final authority. See
[`development-plan/FX_PRD.md`](development-plan/FX_PRD.md). Session context and
build history: [`DEVLOG-phase1.md`](development-plan/DEVLOG-phase1.md) and
[`DEVLOG-phase2.md`](development-plan/DEVLOG-phase2.md). Command reference: [`COMMANDS.md`](COMMANDS.md).

> Invite-only, own-broker-account-only, personal/research use. CFDs are high-risk
> leveraged products. Not financial advice.

## Prerequisites

- Node 22 LTS (`.nvmrc`)
- pnpm 9 via `corepack enable`
- Docker Desktop
- Python 3.11+ (quant stub in `pnpm dev`; real service arrives Step 1.5)

## Quickstart

```bash
corepack enable
pnpm install
cp .env.example .env        # then fill in values
pnpm build                  # turbo: build all workspaces
pnpm test                   # vitest across workspaces
pnpm dev                    # FE-007: dashboard :3000, api :4000, quant :5000
```

## Local Docker stack (BE-004)

```bash
pnpm stack:up               # PG18+TimescaleDB+pgvector, Redis 8 (AOF), quant, api, web
pnpm stack:ps               # all services must be healthy
pnpm stack:down
```

## CI/CD & deploy

- **CI (BE-005):** `.github/workflows/ci.yml` — Biome, tsc, Vitest, Docker builds on
  every PR; merge to main publishes SHA-tagged images to GHCR.
- **Deploy (BE-006):** `.github/workflows/deploy.yml` + `infra/deploy/deploy.sh` —
  zero-downtime rollout to single-node Hetzner Swarm behind Caddy auto-TLS.
  Production database runs outside the Swarm stack on a dedicated volume
  (ADR-006 rev.) — full runbook in [`infra/DEPLOY.md`](infra/DEPLOY.md).

## Workspaces

| Path | Package | Purpose |
|---|---|---|
| `apps/dashboard` | `@fx/dashboard` | Next.js 16 operator dashboard |
| `apis/node-api` | `@fx/node-api` | Fastify modular monolith (Phase 1: minimal boot) |
| `packages/types` | `@fx/types` | Zod 4 contracts — source of truth; JSON Schema emit for Python |
| `packages/api-client` | `@fx/api-client` | Typed, Zod-validated fetch client |
| `packages/auth-client` | `@fx/auth-client` | `useSession`, `useStepUp2FA`, `requireAuth` |
| `packages/tsconfig` | `@fx/tsconfig` | Shared TS configs |
| `services/quant` | `@fx/quant` | Python quant service (Step 1.2 stub; QN-001 in Step 1.5) |
| `workers/` | — | BullMQ workers (Phase 2+) |

`TRADING_MODE` (`backtest | paper | live`) drives one identical code path in every mode.
