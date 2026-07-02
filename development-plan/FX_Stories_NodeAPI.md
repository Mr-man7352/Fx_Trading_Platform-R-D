# FX Platform — Node API, Workers & Infra User Stories

*Companion to [`system-design/FX_System_Design.md`](system-design/FX_System_Design.md)*  
*Version 2.2 · 2026-07-01*  
*Scope: Fastify modular monolith, BullMQ workers, LangGraph agents, infrastructure, CI/CD, observability. Python quant implementation is in [`FX_Stories_PythonQuant.md`](FX_Stories_PythonQuant.md).*

---

## How to use this document

Each story is tracker-ready. Story IDs use prefix `BE-`. Story points use Fibonacci (1, 2, 3, 5, 8, 13). Acceptance criteria are Given/When/Then. DevOps and infra stories live here.

**Story shape**

```
### BE-XXX — Title
**As a** <role> **I want** <capability> **so that** <outcome>.

**Acceptance criteria**
- Given … When … Then …

**Technical notes**
- Implementation hints, file paths, library calls, gotchas.

**Dependencies**
- Other stories that must merge first.

**Points:** N  ·  **Phase:** N  ·  **Epic:** EP-BE-X
```

---

## Pinned package versions (verified 2026-06-28)

| Package | Version | Notes |
|---|---|---|
| Node.js | `22.x LTS` | Pinned via `.nvmrc` |
| `fastify` | `5.x` | v5 line; Node 20+ required |
| `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/sensible`, `@fastify/cookie`, `@fastify/jwt`, `@fastify/websocket` | latest matching fastify@5 | Official plugins |
| `@fastify/swagger` + `@fastify/swagger-ui` | latest | OpenAPI generation |
| `fastify-type-provider-zod` | `5.x` | Zod validation |
| `prisma` / `@prisma/client` | `7.x` | Rust-free, ESM |
| `pg` | latest | TimescaleDB via Prisma |
| `zod` | `4.x` | Shared via `@fx/types` |
| `bullmq` | `5.x` | Job queues |
| `ioredis` | latest | Redis client for BullMQ |
| `@langchain/langgraph` | `1.4.x` | Multi-agent orchestration |
| `jose` | `5.x` | JWT verify (NextAuth shared secret) |
| `@node-rs/argon2` | latest | Password hashing |
| `otpauth` | latest | TOTP 2FA |
| `resend` | latest | Transactional email |
| `pino` + `pino-pretty` | latest | Logging |
| `@sentry/node` | latest | Error tracking |
| `@opentelemetry/api` + auto-instrumentations | latest | Tracing |
| `vitest` | `4.x` | Unit + integration |
| `tsx` | latest | Dev runtime |
| `tsup` | latest | ESM bundle |
| `@biomejs/biome` | latest | Lint + format |
| `typescript` | `5.9.x` | Match FE |

**Infra & ops**

| Tool | Version / channel | Notes |
|---|---|---|
| PostgreSQL | `18.x` + TimescaleDB `2.28.x` (community edition) | Hypertables, CAGGs, compression, retention; **self-hosted in prod on dedicated volume (ADR-006 rev.)** — Neon rejected: Apache-2 edition lacks CAGGs/retention/compression |
| `pgvector` | latest | Agent memory embeddings |
| Redis | `8.x` | BullMQ + cache; **AOF `everysec` persistence required** |
| Twilio | API latest | SMS for critical alerts (BE-118) |
| Docker + Compose | latest | Local dev |
| Docker Swarm | single-node prod | Hetzner |
| Caddy | `2.x` | Auto TLS |
| GitHub Actions | latest | CI/CD → GHCR |
| Grafana / Loki / Tempo | latest | Observability |
| Restic | latest | Backups → S3 |

---

## Table of contents

- **EP-BE-1** — Repo foundations, env, CI/CD *(Phase 1)*
- **EP-BE-2** — Fastify bootstrap & cross-cutting plugins *(Phase 1)*
- **EP-BE-3** — Prisma + TimescaleDB schema *(Phase 1)*
- **EP-BE-4** — Auth (Google OAuth sync + email/password + 2FA + invites) *(Phase 5)*
- **EP-BE-5** — Market data module & Timescale ingestion *(Phase 1)*
- **EP-BE-6** — Trades, execution API & reconciliation *(Phase 2)*
- **EP-BE-7** — Multi-agent signal engine (LangGraph.js) *(Phase 3)* — incl. BE-068 circuit breaker, BE-069 context contracts, BE-074 context assembler
- **EP-BE-8** — Deterministic risk gate *(Phase 3)*
- **EP-BE-9** — Trade supervision worker *(Phase 4)*
- **EP-BE-10** — Backtest orchestration API *(Phase 4)*
- **EP-BE-11** — Settings, mode toggle & broker creds *(Phase 5)*
- **EP-BE-12** — Notifications (Telegram, email, WS) *(Phase 5)*
- **EP-BE-13** — Go-live hardening & chaos tests *(Phase 6)*
- **EP-BE-14** — Compliance, audit & GDPR *(cross-cutting)*
- **EP-BE-15** — Observability & deploys *(Phase 1 / 5)*

---

## EP-BE-1 — Repo foundations, env, CI/CD

### BE-001 — Bootstrap `apis/node-api` workspace
**As a** developer **I want** the Node API workspace in the monorepo **so that** backend work has a home.

**Acceptance criteria**
- Given the monorepo, when `pnpm install` runs, then `apis/node-api` resolves with `package.json`, `tsconfig.json`, `Dockerfile`.
- Given `pnpm --filter @fx/node-api dev`, when run, then `tsx watch src/server.ts` boots on `:4000`.
- Given `pnpm --filter @fx/node-api build`, when run, then `tsup` emits ESM to `dist/`.

**Technical notes**
- ESM-only (`"type": "module"`); Node 22 LTS.

**Dependencies** — FE-001. **Points:** 2 · **Phase:** 1 · **Epic:** EP-BE-1

---

### BE-002 — Typed env loader with Zod
**As a** developer **I want** fail-fast env validation **so that** misconfigurations don't reach production.

**Acceptance criteria**
- Given `env.ts` with Zod, when boot with missing key, then clear error list and no server start.
- Given new env key, when pushed, then CI verifies it is in `.env.example`.

**Dependencies** — BE-001. **Points:** 2 · **Phase:** 1 · **Epic:** EP-BE-1

---

### BE-003 — `TRADING_MODE` flag wired globally
**As an** operator **I want** one flag (`backtest|paper|live`) through all services **so that** the same code path runs in every mode.

**Acceptance criteria**
- Given `TRADING_MODE=paper`, when workers and quant service boot, then all read the same mode without code change.
- Given mode switch via settings API, when applied, then audit log records change; live requires step-up 2FA + promotion gate.

**Dependencies** — BE-002. **Points:** 3 · **Phase:** 1 · **Epic:** EP-BE-1

---

### BE-004 — Docker Compose local stack
**As a** developer **I want** `docker compose up` for PG18+TimescaleDB, Redis, quant, api, web **so that** the full stack runs locally.

**Acceptance criteria**
- Given `infra/docker-compose.local.yml`, when started, then all services pass healthchecks.
- Given quant gRPC, when signal worker calls, then response within 30s latency budget (H1).
- Given production deploy docs, when reviewed, then the production database is the self-hosted TimescaleDB instance on a dedicated volume with its own lifecycle, separate from the Swarm application stack; dev and prod use the identical image.

**Dependencies** — BE-001, QN-001. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-1

---

### BE-005 — CI pipeline (lint, test, build, GHCR publish)
**As a** developer **I want** GitHub Actions on every PR **so that** broken changes can't merge.

**Acceptance criteria**
- Given a PR, when CI runs, then Biome, `tsc`, Vitest, and Docker build succeed.
- Given merge to main, when pipeline completes, then images tagged by commit SHA publish to GHCR.

**Dependencies** — BE-001, FE-003. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-1

---

### BE-006 — Zero-downtime deploy to Hetzner Swarm
**As an** operator **I want** scripted deploy with Caddy auto-TLS **so that** releases roll safely.

**Acceptance criteria**
- Given deploy script, when run, then new containers replace old with healthcheck gate; rollback on failure.
- Given production URL, when accessed, then TLS valid via Caddy.

**Dependencies** — BE-005. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-1

---

## EP-BE-2 — Fastify bootstrap & cross-cutting plugins

### BE-010 — Fastify server bootstrap with Pino logging
**As a** developer **I want** production-grade Fastify **so that** everything plugs into a consistent shell.

**Acceptance criteria**
- Given boot, when process starts, then Fastify listens on `:4000` with JSON Pino logs.
- Given a request, when handled, then logs include `requestId`, `method`, `url`, `statusCode`, `responseTime`, `userId`.
- Given SIGTERM, when received, then graceful shutdown within 30s.
- Given `GET /healthz`, when hit, then `{ status: 'ok', commit, uptime, tradingMode }`.

**Dependencies** — BE-002. **Points:** 3 · **Phase:** 1 · **Epic:** EP-BE-2

---

### BE-011 — Cross-cutting plugins: helmet, CORS, rate-limit
**As a** developer **I want** baseline security plugins **so that** the API has sane defaults.

**Acceptance criteria**
- Given disallowed origin, when request received, then CORS rejects.
- Given >100 req/min from one IP, when detected, then 429 returned.
- Given 4xx/5xx, when produced, then consistent JSON error shape with `requestId`.

**Dependencies** — BE-010. **Points:** 3 · **Phase:** 1 · **Epic:** EP-BE-2

---

### BE-012 — Zod-validated routes (`fastify-type-provider-zod`)
**As a** developer **I want** routes typed from Zod **so that** validation matches `@fx/types`.

**Acceptance criteria**
- Given invalid body, when posted, then 400 with field-level errors.
- Given `pnpm openapi`, when run, then current `openapi.json` emits for api-client codegen.

**Dependencies** — BE-011, FE-004. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-2

---

### BE-013 — Request context + audit middleware
**As a** developer **I want** typed `RequestContext` on every handler **so that** auth and audit are uniform.

**Acceptance criteria**
- Given authenticated request, when handler runs, then `req.context` has `{ user, role, stepUp2FAAt, requestId }`.
- Given state-changing action, when completed, then `audit_log` row appended immutably.

**Technical notes**
- Phase 1 runs with an internal service token as the auth stand-in; NextAuth JWT middleware (BE-030) lands in Phase 5 and replaces it transparently behind the same `RequestContext` shape.

**Dependencies** — BE-012. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-2

---

### BE-014 — WebSocket gateway (`@fastify/websocket`)
**As the** frontend **I want** a WebSocket endpoint streaming live events **so that** the dashboard updates in real time.

**Acceptance criteria**
- Given authenticated WS connection to `/ws`, when subscribed to `user:{userId}:events`, then events deliver within 500ms p95.
- Given JWT expired mid-session, when detected, then connection closes with re-auth hint.

**Dependencies** — BE-030. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-2

---

### BE-015 — OpenAPI + Swagger UI
**As a** developer **I want** auto-generated API docs **so that** the frontend has a live reference.

**Acceptance criteria**
- Given Fastify swagger plugin, when generated, then OpenAPI 3.1 covers all routes.
- Given `/docs` in non-prod, when opened, then Swagger UI loads.

**Dependencies** — BE-012. **Points:** 3 · **Phase:** 1 · **Epic:** EP-BE-2

---

## EP-BE-3 — Prisma + TimescaleDB schema

### BE-020 — TimescaleDB hypertables + continuous aggregates
**As a** developer **I want** hypertables for candles/ticks and CAGGs M5→D1 **so that** time-series queries are fast.

**Acceptance criteria**
- Given migration applied, when hypertables verified, then CAGGs refresh and retention policies set.
- Given H1 query on EUR/USD 1-year range, when run, then p95 latency <100ms on dev hardware.
- Given the production instance (self-hosted TimescaleDB **community edition**), when CAGGs, compression, and retention are verified, then full feature parity with dev is confirmed. (Neon was rejected for prod: its Apache-2 TimescaleDB build lacks all three — ADR-006 rev.)

**Dependencies** — BE-004. **Points:** 8 · **Phase:** 1 · **Epic:** EP-BE-3

---

### BE-021 — Prisma schema for MVP entities
**As a** developer **I want** Prisma schema for users, trades, signals, agent_runs, agent_memory, audit **so that** the API can persist data.

**Acceptance criteria**
- Given `prisma/schema.prisma`, when migrated, then all core tables from system design §7 exist with indexes.
- Given `agent_memory` table, when migrated, then includes `bar_ts`, `instrument`, `agent_role`, `summary`, `embedding` (pgvector) columns.
- Given `prisma generate`, when run, then TypeScript client emits.

**Dependencies** — BE-020. **Points:** 13 · **Phase:** 1 · **Epic:** EP-BE-3

---

### BE-022 — Migration pipeline + safety checks
**As a** developer **I want** safe migrations in CI **so that** prod schema never breaks accidentally.

**Acceptance criteria**
- Given PR with migration, when CI runs, then Postgres container applies and verifies schema.
- Given destructive migration, when proposed without marker, then CI fails.

**Dependencies** — BE-021. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-3

---

### BE-023 — Seed scripts for dev
**As a** developer **I want** deterministic seed data **so that** new joiners can explore immediately.

**Acceptance criteria**
- Given `pnpm seed:dev`, when run, then test user, invite code, sample candles, and fixture signal created.

**Dependencies** — BE-021. **Points:** 3 · **Phase:** 1 · **Epic:** EP-BE-3

---

## EP-BE-4 — Auth (Google OAuth sync + email/password + 2FA + invites)

### BE-030 — NextAuth JWT verification middleware
**As a** developer **I want** every authenticated request JWT-verified **so that** identity is trustworthy.

**Acceptance criteria**
- Given valid Bearer JWT, when received, then `req.context.user` populated from claims.
- Given expired/tampered token, when received, then 401 `{ code: 'INVALID_TOKEN' }`.
- Given suspended user, when token valid, then 403.

**Technical notes**
- `jose` `jwtVerify()` with `NEXTAUTH_SECRET`; verify `exp`, `iat`.

**Dependencies** — BE-013. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-4

---

### BE-031 — User upsert on sign-in (`POST /auth/sign-in-sync`)
**As a** developer **I want** user records upserted on every sign-in **so that** local data stays current.

**Acceptance criteria**
- Given server-to-server call with `INTERNAL_SYNC_TOKEN`, when Google sign-in sync received, then user upserted by email/google_sub.
- Given first-time Google user without invite, when sync called, then `requiresInvite: true` returned.
- Given duplicate calls, when received, then idempotent.

**Dependencies** — BE-030, BE-021. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-4

---

### BE-032 — Email/password registration (`POST /auth/register`)
**As an** invited operator **I want** to register with email/password **so that** I can access without Google.

**Acceptance criteria**
- Given valid invite code + email + password, when registered, then user created with argon2 hash; verification email sent.
- Given duplicate email, when registered, then 409.
- Given invalid invite, when submitted, then 422 without revealing whether email exists.

**Dependencies** — BE-035. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-4

---

### BE-033 — Credentials login (`POST /auth/login`)
**As the** Credentials provider **I want** a login endpoint **so that** NextAuth can validate email/password.

**Acceptance criteria**
- Given verified email + correct password, when login called, then `{ userId, email, role }` returned for NextAuth callback.
- Given unverified email, when login attempted, then 403 `EMAIL_NOT_VERIFIED`.
- Given wrong password, when attempted, then 401 generic error; rate-limited after 5 failures.

**Dependencies** — BE-032. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-4

---

### BE-034 — Email verification + password reset tokens
**As a** developer **I want** signed expiring tokens for verify/reset **so that** email flows are secure.

**Acceptance criteria**
- Given verification token, when `GET /auth/verify?token=` valid, then `email_verified_at` set.
- Given reset token, when `POST /auth/reset-password` valid, then password updated and token invalidated.
- Given expired token, when used, then 410.

**Technical notes**
- Resend for email delivery; tokens hashed in DB.

**Dependencies** — BE-032. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-4

---

### BE-035 — Invite code validation + CRUD
**As an** operator **I want** invite codes for closed registration **so that** access stays invite-only.

**Acceptance criteria**
- Given `POST /admin/invites`, when called with auth, then invite code created with expiry and max uses.
- Given registration with code, when validated, then use count incremented; expired/maxed codes rejected.
- Given invite list, when queried, then shows usage stats and audit trail.

**Dependencies** — BE-021. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-4

---

### BE-036 — TOTP 2FA enroll/verify + step-up flag
**As an** operator **I want** TOTP 2FA for sensitive operations **so that** kill-switch and live mode are protected.

**Acceptance criteria**
- Given `POST /auth/2fa/enroll`, when completed with valid TOTP, then encrypted secret stored.
- Given `POST /auth/2fa/verify`, when valid code, then `stepUp2FAAt` returned for JWT enrichment (15 min TTL).
- Given protected route (kill-switch), when `stepUp2FAAt` stale, then 403 `STEP_UP_2FA_REQUIRED`.
- Given enrollment completion, when secret stored, then **10 single-use recovery codes** issued (argon2-hashed at rest, shown once); a valid recovery code satisfies step-up and is consumed on use.
- Given all recovery codes consumed or lost, when operator invokes documented break-glass procedure, then re-enrollment path exists without locking the operator out of the kill-switch.

**Dependencies** — BE-030. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-4

---

### BE-037 — Account linking (Google ↔ credentials)
**As an** operator **I want** to link Google and password on same account **so that** I can sign in either way.

**Acceptance criteria**
- Given verified credentials account, when Google sign-in with same email, then `google_sub` linked to existing row.
- Given Google-only account, when password set via settings, then `password_hash` added after step-up 2FA.

**Dependencies** — BE-031, BE-033. **Points:** 3 · **Phase:** 5 · **Epic:** EP-BE-4

---

## EP-BE-5 — Market data module & Timescale ingestion

### BE-040 — Market-data BullMQ worker
**As the** system **I want** a worker streaming prices and aggregating candles **so that** H1 bars appear in TimescaleDB.

**Acceptance criteria**
- Given live feed, when ticks arrive, then H1 EUR/USD candles appear within one bar period.
- Given bar close, when candle complete, then job enqueued to `signals` queue.

**Dependencies** — BE-004, QN-020. **Points:** 8 · **Phase:** 1 · **Epic:** EP-BE-5

---

### BE-041 — Vendor adapter interface + backfill
**As a** developer **I want** a pluggable vendor-adapter interface (OANDA backfill first) **so that** historical backfill and cross-check work, and paid vendors can be added later without refactoring.

**Acceptance criteria**
- Given the OANDA adapter, when backfill runs, then 6 months of candles for configured instruments (incl. XAU_USD) load idempotently.
- Given the Twelve Data cross-check adapter (free tier), when sampled comparison runs, then discrepancies vs broker candles are logged.
- Given the adapter interface, when a new vendor (e.g. Polygon/Massive) is added, then no changes to the backfill job are required.

**Dependencies** — BE-040. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-5

---

### BE-042 — Point-in-time news archive API
**As the** quant core **I want** news stored with accurate `published_at` **so that** backtests have no look-ahead.

**Acceptance criteria**
- Given news ingest, when stored, then duplicates collapsed; `published_at` indexed.
- Given backtest query, when `published_at <= bar_ts` enforced, then unit test passes.

**Dependencies** — BE-021. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-5

---

### BE-043 — Macro features ingest (COT, EIA, FRED)
**As the** quant core **I want** macro features with release-time awareness **so that** COT joins on release not reference date.

**Acceptance criteria**
- Given COT ingest, when joined in backtest, then no look-ahead unit test passes.

**Dependencies** — BE-042. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-5

---

### BE-044 — Data-quality monitor
**As an** operator **I want** gap/stale/spread anomaly detection **so that** bad data can halt trading.

**Acceptance criteria**
- Given injected gap, when detected, then alert fires and degraded state surfaces to risk gate.

**Dependencies** — BE-040. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-5

---

### BE-045 — Market REST endpoints (candles, instruments)
**As the** frontend **I want** REST endpoints for candles and instruments **so that** charts can load data.

**Acceptance criteria**
- Given `GET /market/candles?instrument=&timeframe=&from=&to=`, when called, then typed OHLCV paginated response.
- Given `GET /market/instruments`, when called, then list with broker symbol mappings.

**Dependencies** — BE-012, BE-020. **Points:** 3 · **Phase:** 5 · **Epic:** EP-BE-5

---

## EP-BE-6 — Trades, execution API & reconciliation

### BE-050 — Execution worker + order lifecycle
**As the** system **I want** idempotent order placement with broker SL/TP **so that** trades persist with full provenance.

**Acceptance criteria**
- Given TradeIntent from signal worker, when executed, then order placed with UUID client tag; fill persisted with `broker_trade_id`.
- Given retry, when same UUID, then idempotent — no duplicate order.
- Given partial fill (`fill_qty < requested_qty`), when received, then partial accepted, remainder logged, no same-bar auto-retry; operator notified via WS + Telegram.
- Given order REJECTED (INSUFFICIENT_MARGIN, MARKET_HALTED, or other broker reason code), when received, then intent marked `REJECTED` with reason code, no retry storm, operator alerted, audit row written.

**Dependencies** — QN-032, BE-021. **Points:** 8 · **Phase:** 2 · **Epic:** EP-BE-6

---

### BE-051 — Trailing stop, partial close, breakeven manager
**As a** trader **I want** automated trade management polling every 30s **so that** +1R partial and trail engage correctly.

**Acceptance criteria**
- Given open trade at +1R, when manager runs, then partial close executes; SL moved to breakeven per config.

**Dependencies** — BE-050. **Points:** 5 · **Phase:** 2 · **Epic:** EP-BE-6

---

### BE-052 — Reconciler (60s broker ↔ DB)
**As an** operator **I want** reconciliation every 60s **so that** mismatches halt trading.

**Acceptance criteria**
- Given injected mismatch, when reconciler runs, then configured action (flatten-and-halt or halt) triggers + alert.

**Dependencies** — BE-050. **Points:** 5 · **Phase:** 2 · **Epic:** EP-BE-6

---

### BE-053 — Dead-man's switch / off-host watchdog (ADR-013)
**As an** operator **I want** an **off-host** watchdog with its own broker access **so that** positions aren't left unmanaged even if the entire host dies.

**Acceptance criteria**
- Given the watchdog deployed on **separate infrastructure** (different provider or region from the Hetzner host), when it polls the platform heartbeat endpoint, then healthy state is confirmed on schedule.
- Given the **entire Hetzner host unreachable** (not just the process), when heartbeat timeout elapses, then watchdog flattens all open positions **directly via the OANDA REST API using its own scoped token** within the configured window, and fires Telegram + SMS.
- Given watchdog credentials, when audited, then the token is scoped to close/read only (no new positions) and stored outside the main stack.
- Given watchdog itself down, when its own heartbeat (dead-man's-dead-man: a simple external uptime check) fails, then operator alerted.

**Technical notes**
- Minimal process (single container/VM on another provider, or a scheduled runner as fallback). Must not share fate with the Swarm host in any failure mode.

**Dependencies** — BE-050. **Points:** 5 · **Phase:** 2 · **Epic:** EP-BE-6

---

### BE-054 — Trades REST endpoints
**As the** frontend **I want** trades/positions endpoints **so that** dashboard and history views load.

**Acceptance criteria**
- Given `GET /trades` and `GET /trades/:id`, when called, then typed responses with provenance ids.
- Given CSV export endpoint, when called, then downloadable trade history.

**Dependencies** — BE-012, BE-021. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-6

---

## EP-BE-7 — Multi-agent signal engine (LangGraph.js)

### BE-060 — LLM provider factory + automatic failover
**As an** operator **I want** per-agent model override, temp 0, JSON mode, cost cap, and automatic provider failover **so that** LLM spend is controlled and degraded providers don't block trading.

**Acceptance criteria**
- Given monthly cap at 90%, when threshold hit, then auto-downgrade to cheaper models; PM retains premium until 95%.
- Given each call, when complete, then cost ledger + `agent_runs` row written with `model_downgraded` flag when applicable.
- Given Anthropic 5xx or timeout (>30s), when detected, then immediate failover to OpenRouter (same model family) → OpenAI within same call attempt.
- Given provider latency p95 >15s over 5 min, when 2 consecutive slow calls occur, then downgrade via OpenRouter logged in `agent_runs`.
- Given 429 rate-limit, when received, then exponential backoff max 10s then failover to next provider in chain.
- Given failover triggered, when fallback attempted, then **exactly one fallback attempt with a 10s timeout** — a stage's worst case never doubles (§2.2).
- Given the 90-day paper window, when >10% of bars ran with `model_downgraded: true`, then the window auto-extends until ≥90% of bars are full-capability (downgraded bars excluded from promotion evidence).

**Technical notes**
- Failover chain: Anthropic → OpenRouter (same model family) → OpenAI → Gemini. Downgrade targets are capability tiers mapped in the provider factory — never hardcoded model names. See system design §9.4.

**Dependencies** — BE-013. **Points:** 8 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-061 — Prompt registry + model snapshot pinning
**As an** auditor **I want** exact model + prompt_hash per decision **so that** decisions are reproducible.

**Acceptance criteria**
- Given agent run, when persisted, then model snapshot + `prompt_hash` recorded; provider change flags re-validation.

**Dependencies** — BE-060. **Points:** 3 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-062 — LangGraph domain specialists + debate + consensus
**As the** system **I want** domain-specialist analysts → bull/bear debate → trader → risk team → PM **so that** candidates are confirmed/vetoed with auditable transcripts.

**Acceptance criteria**
- Given quant candidate on fixture, when graph runs, then valid JSON from each agent per `AgentContextContract` schema; transcript in `agent_debates`.
- Given three specialist analysts (technical, macro, sentiment), when run, then each receives only its domain feature subset per §9.6 contract.
- Given debate rounds config 0/1/2, when changed, then behaviour matches setting.
- Given regime uncertainty high (HMM entropy > threshold), when bar processed, then debate rounds auto-set to 2 regardless of static config.
- Given bull/bear split vote (confidence diff <0.1), when trader runs, then `tiebreaker_mode: QUANT_DEFAULT` applied — follow quant if P ≥ threshold, else HOLD.
- Given trader agent, when run, then receives full debate transcript; PM receives debate summary only.
- Given the three specialists, when invoked, then they run **in parallel** (disjoint inputs by contract; 20s parallel budget per §2.2).
- Given the PM summary, when produced, then it is a **deterministic digest** assembled by code from schema-validated agent JSON — stances, confidences, final-round arguments, trader action, risk concerns, tiebreaker flag — never an LLM summarizer (ADR-011).
- Given a single specialist timeout, when graph continues, then that role contributes `NEUTRAL` and the transcript notes the degradation (no whole-graph HOLD for one missing analyst).

**Dependencies** — BE-060, BE-069, BE-074, QN-040. **Points:** 13 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-063 — Prompt-injection hardening + adversarial red-team suite
**As a** security owner **I want** news text treated as untrusted data and a diverse injection test suite **so that** injected headlines don't alter agent behaviour.

**Acceptance criteria**
- Given injected instruction in headline fixture, when agents run, then behaviour unchanged; test passes.
- Given red-team suite (≥20 patterns: instruction override, role-play, delimiter escape, central-bank headline mimicry, JSON injection, multi-language), when CI runs, then all patterns produce identical agent decisions vs clean baseline.
- Given a **memory-persistence attack** (adversarial headline processed at bar N whose influence is written into the reflection), when memories are retrieved at bar N+k, then no injected instruction propagates via `agent_memory` — reflections derived from adversarial fixtures are asserted clean. Memory turns a one-bar injection into a durable one; this attack class is mandatory in the suite.
- Given new injection pattern discovered in production, when added to suite, then regression test required before deploy.

**Dependencies** — BE-062. **Points:** 8 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-064 — Agent memory (required) with vector retrieval
**As a** researcher **I want** first-class reflection memory with `bar_ts`-bounded vector retrieval **so that** agents synthesise across bars without look-ahead.

**Acceptance criteria**
- Given memory enabled (default on for paper/live), when agent runs, then top-K memories retrieved where `memory.bar_ts <= current_bar_ts` and instrument matches.
- Given backtest queries, when run, then no lessons newer than `bar_ts` retrieved; look-ahead test passes.
- Given PM decision complete, when reflection node runs, then summary embedded and written to `agent_memory`.
- Given trade close (or candidate expiry), when the outcome is known, then the reflection is **updated with realized outcome** (R-multiple, SL/TP hit, holding period) — retrieval surfaces what worked, not just what was argued.
- Given memory growth, when hygiene job runs, then max 500 memories per instrument enforced (relevance-weighted eviction), near-duplicates (cosine >0.95) merged, and memories >18 months decay out of top-K ranking.
- Given each memory row, when written, then `embedding_model` is pinned; an embedding model change requires an explicit re-embed migration (never silent mixing).
- Given each agent invocation, when memories are retrieved, then `retrieved_memory_ids` are persisted on the `agent_runs` row (required for QN-062 deterministic replay).
- Given memory disabled (quant-only ablation), when flag set, then agents run stateless per-bar for comparison.

**Technical notes**
- `packages/agent-memory/` — pgvector retrieval; K=5 default. See system design §9.5.

**Dependencies** — BE-062, BE-021. **Points:** 8 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-065 — Disagreement cohort logging
**As a** researcher **I want** quant vs LLM conflicts logged **so that** veto value is measurable.

**Acceptance criteria**
- Given quant approves and PM vetoes (or reverse), when logged, then cohort queryable with outcome tracking.

**Dependencies** — BE-062. **Points:** 3 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-066 — Signals worker (entry cycle + timeouts + concurrency)
**As the** system **I want** signal worker running full entry pipeline on bar close with explicit timeout budgets **so that** candidates flow to execution without hanging jobs.

**Acceptance criteria**
- Given H1 bar close job, when processed, then gRPC quant → **entry gate** → context assembly → LangGraph → risk-gate → execution queue on APPROVE.
- Given bar close with **no quant candidate, or candidate P < 0.50 pre-filter**, when the deterministic entry gate evaluates, then HOLD logged as `gate_skip` with **zero LLM cost** — the agent graph never fires (ADR-010; mirrors BE-080's supervision gate).
- Given gRPC timeout (>30s H1), when exceeded, then HOLD returned; job completes without unhandled throw; circuit breaker incremented.
- Given LangGraph timeout (>120s H1) or any per-stage sub-budget overrun (§2.2), when exceeded, then HOLD; partial transcript persisted.
- Given end-to-end timeout (>180s H1, **measured from LangGraph semaphore acquisition**, not job enqueue), when exceeded, then HOLD; BullMQ job marked complete (no silent retry loop).
- Given 3+ instruments at same bar close, when processed, then max 3 concurrent LangGraph runs; excess queued by liquidity priority; queued instruments' E2E clocks start at semaphore acquisition so they are never starved into systematic HOLDs.

**Dependencies** — BE-040, BE-062, BE-068, BE-070, QN-040. **Points:** 13 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-067 — Signals REST + WS fanout
**As the** frontend **I want** signal and debate data via REST and WebSocket **so that** agents view updates live.

**Acceptance criteria**
- Given `GET /signals`, when called, then recent candidates with agent summary.
- Given new debate event, when emitted, then WS subscribers receive within 500ms.

**Dependencies** — BE-014, BE-066. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-7

---

### BE-068 — gRPC circuit breaker (Node → Python)
**As the** system **I want** a circuit breaker on the gRPC boundary to Python quant **so that** slow/unresponsive quant service defaults to HOLD instead of hanging or throwing unhandled errors.

**Acceptance criteria**
- Given quant service slow (>30s), when `RunPipeline` called, then call times out gracefully; signal worker returns HOLD with reason `GRPC_TIMEOUT`.
- Given 3 consecutive gRPC failures in 5 min, when circuit opens, then all subsequent calls default HOLD for **60s** without attempting connection (matches §2.2).
- Given circuit half-open after the 60s cooldown, when probe succeeds, then circuit closes; normal operation resumes.
- Given circuit open, when BullMQ job processes, then job completes successfully (HOLD) — no unhandled throw triggering silent BullMQ retries.

**Technical notes**
- Implement in `workers/signals/src/grpc-client.ts` using opossum or equivalent circuit breaker library.

**Dependencies** — BE-004, QN-004. **Points:** 5 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-069 — Agent context contracts (`@fx/types`)
**As a** developer **I want** formal per-role input/output Zod schemas **so that** agent prompts are versioned, testable, and not ad-hoc.

**Acceptance criteria**
- Given `AgentContextContract` in `@fx/types`, when defined, then schemas exist for all 8 agent roles per system design §9.6.
- Given agent graph run, when each agent completes, then output validated against role schema; validation failure → HOLD for that agent.
- Given fixture test per role, when run in CI, then schema validation passes for golden outputs.
- Given schema change, when version bumped, then `prompt_hash` changes and re-validation flag set.

**Dependencies** — BE-061, FE-004. **Points:** 5 · **Phase:** 3 · **Epic:** EP-BE-7

---

### BE-074 — Agent context assembler
**As the** signal worker **I want** a single component that builds and validates every agent's context bundle **so that** context construction is owned, testable, and never ad-hoc inside graph nodes.

**Acceptance criteria**
- Given a gated candidate, when the assembler runs, then quant features are partitioned into `technical` / `macro` / `sentiment` subsets exactly per §9.6 contracts.
- Given the sentiment analyst bundle, when built, then headlines are fetched from `news_archive` with `published_at <= bar_ts` (gRPC `RunPipeline` returns features only — headline text is the assembler's job) and wrapped in the untrusted-data block.
- Given each role bundle, when built, then the full bundle is **validated against `AgentContextContract` before invocation**; validation failure → that role = HOLD/NEUTRAL with reason code. (Memory retrieval per §9.5 plugs into the assembler when BE-064 lands — the assembler exposes the slot; BE-064 fills it.)
- Given the PM bundle, when built, then the debate summary is the deterministic digest (ADR-011) — assembled from schema-validated agent outputs, no LLM call.
- Given fixture bundles per role, when CI runs, then golden-file tests pass.

**Dependencies** — BE-069, BE-042. **Points:** 5 · **Phase:** 3 · **Epic:** EP-BE-7

---

## EP-BE-8 — Deterministic risk gate

### BE-070 — `packages/risk-gate` rule engine
**As a** risk owner **I want** non-LLM rules enforcing caps, DD, blackout, spread, session, rollover, and gap filters **so that** final authority never delegates to LLM.

**Acceptance criteria**
- Given candidate, when evaluated, then all rules in system design §10 checked; unit tests per rule and combination.
- Given NFP blackout fixture, when entry attempted, then VETO with reason code.
- Given P(profitable) = 0.58, when entry attempted, then VETO (`PROB_BELOW_THRESHOLD`; default threshold 0.60).
- Given instrument daily loss >2% equity, when entry attempted on same instrument, then VETO (`INSTRUMENT_DAILY_LOSS`).
- Given Wednesday rollover (17:00 New York, DST-aware) and XAU position held >2 days, when evaluated, then warning flag; optional auto-flatten if configured.
- Given the pre-close window before Friday 17:00 **New York time (DST-aware — 21:00/22:00 UTC)** and high-vol regime, when weekend gap flatten enabled, then existing positions flagged for pre-close flatten.
- Given a summer fixture bar and a winter fixture bar, when session/rollover rules evaluate, then both resolve correctly (DST regression test).
- Given spread >5× session median (flash crash), when detected, then halt new entries + critical alert.

**Dependencies** — BE-003, QN-047. **Points:** 13 · **Phase:** 3 · **Epic:** EP-BE-8

---

### BE-071 — Correlation clustering cap (consumes QN-048 clusters)
**As a** risk owner **I want** max 2 trades per correlation cluster with the clustering computed in Python **so that** correlated exposure is limited and Node never does maths (§3.1).

**Acceptance criteria**
- Given the cluster table published by QN-048 (hierarchical clustering, Pearson, 60-day lookback, 0.7 threshold), when the risk gate evaluates a candidate, then cap enforced (max 2 per cluster) — the gate **consumes** clusters, never computes them.
- Given cluster membership changes, when the weekly refresh **or an event-triggered recompute** (liquidity-regime transition, realized-vol spike — the risk-off case that motivated this story) runs in QN-048, then the gate picks up new clusters on next evaluation and open exposure is re-checked against them.
- Given manual override, when operator sets cluster exemption, then audit log records override with reason.
- Given correlation threshold, lookback window, and refresh frequency, when configured via settings, then defaults match system design §10 and propagate to QN-048.

**Dependencies** — BE-070, QN-048. **Points:** 3 · **Phase:** 3 · **Epic:** EP-BE-8

---

### BE-072 — Master kill-switch API
**As an** operator **I want** kill-switch cancelling pending and closing open in <2s **so that** I can stop all trading instantly.

**Acceptance criteria**
- Given `POST /settings/kill-switch` with valid step-up 2FA, when triggered, then pending cancelled, open closed, workers paused in <2s timed test.
- Given a close order rejected or partially filled during kill-switch execution, when detected, then retries with escalating alerts; state reports `CLOSING` (never `CLOSED`) until broker-confirmed flat; reconciler (BE-052) is the backstop.

**Technical notes**
- Ships in Phase 3 guarded by the internal auth stand-in (see BE-013 note); step-up 2FA enforcement activates automatically when BE-036 lands in Phase 5 — no hard dependency, no phase inversion.

**Dependencies** — BE-070, BE-073. **Points:** 8 · **Phase:** 3 · **Epic:** EP-BE-8

---

### BE-073 — Kill-switch state persistence (Postgres source of truth, ADR-012)
**As a** risk owner **I want** kill-switch state persisted in Postgres with Redis as a fast-path cache only **so that** a Redis restart can never silently clear the most safety-critical flag in the system.

**Acceptance criteria**
- Given kill-switch activation, when written, then a Postgres row is the source of truth (with audit trail); the Redis flag is a cache.
- Given any worker boot or Redis cache miss, when state is read, then the worker re-hydrates from Postgres before processing any job.
- Given Redis flushed/restarted while kill-switch is active, when workers next evaluate, then trading remains halted (chaos-tested in BE-120).
- Given Redis, when configured, then AOF `everysec` persistence is enabled and verified in deploy checks (BullMQ durability depends on it).

**Dependencies** — BE-021, BE-004. **Points:** 3 · **Phase:** 3 · **Epic:** EP-BE-8

---

## EP-BE-9 — Trade supervision worker

### BE-080 — Supervision queue + deterministic gate
**As the** system **I want** gated LLM supervision on open trades **so that** LLM runs only when material change detected.

**Acceptance criteria**
- Given open trade, when nothing changed, then HOLD with zero LLM cost logged as `gate_skip`.
- Given material change, when gate passes, then LLM supervisor runs with strict JSON validators.

**Dependencies** — BE-050, BE-062. **Points:** 8 · **Phase:** 4 · **Epic:** EP-BE-9

---

### BE-081 — Layered exit system
**As a** trader **I want** hard SL/TP, ATR trail, time stop, pre-news flatten, DD halt **so that** any one trigger can close a trade.

**Acceptance criteria**
- Given each exit layer, when tested in isolation, then trigger fires correctly; first-to-fire wins.

**Dependencies** — BE-080. **Points:** 5 · **Phase:** 4 · **Epic:** EP-BE-9

---

## EP-BE-10 — Backtest orchestration API

### BE-090 — Backtest trigger + results API
**As a** researcher **I want** API to run and fetch backtests **so that** the frontend can display results.

**Acceptance criteria**
- Given `POST /backtests`, when called, then job enqueued; quant service runs vectorbt engine.
- Given `GET /backtests/:id`, when complete, then metrics, OOS split, validation verdict, ablation returned.

**Dependencies** — QN-050, BE-012. **Points:** 8 · **Phase:** 4 · **Epic:** EP-BE-10

---

## EP-BE-11 — Settings, mode toggle & broker creds

### BE-100 — Settings CRUD API
**As an** operator **I want** settings for risk, LLM models, agent weights, debate rounds **so that** config persists and takes effect.

**Acceptance criteria**
- Given `PATCH /settings`, when valid payload, then persisted and next signal cycle uses new values.
- Given broker creds write, when submitted, then libsodium-encrypted storage; step-up 2FA required.

**Dependencies** — BE-036, BE-021. **Points:** 8 · **Phase:** 5 · **Epic:** EP-BE-11

---

### BE-101 — Live-promotion gate
**As an** operator **I want** live mode blocked until validation + 2FA + signed report **so that** go-live is deliberate.

**Acceptance criteria**
- Given failed validation or missing 90-day paper record, when live toggle attempted, then 403 with checklist of unmet conditions.

**Dependencies** — BE-100, BE-036, QN-060. **Points:** 5 · **Phase:** 6 · **Epic:** EP-BE-11

---

### BE-110 — Economic calendar service
**As a** risk owner **I want** calendar with ±30min blackout **so that** entries blocked around high-impact events.

**Acceptance criteria**
- Given NFP fixture time, when blackout active, then risk gate blocks entries for affected currencies.

**Dependencies** — BE-070. **Points:** 5 · **Phase:** 3 · **Epic:** EP-BE-11

---

## EP-BE-12 — Notifications

### BE-115 — Telegram bot for trade events
**As an** operator **I want** Telegram alerts for fills, halts, reconciliation mismatches **so that** I'm notified away from dashboard.

**Acceptance criteria**
- Given trade fill, when event fires, then Telegram message with reason code and P&L.

**Dependencies** — BE-050. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-12

---

### BE-116 — Resend email digests
**As an** operator **I want** daily/weekly email summaries **so that** I have a record of performance.

**Acceptance criteria**
- Given cron at 22:00 UTC, when daily summary job runs, then email sent via Resend.

**Dependencies** — BE-002. **Points:** 3 · **Phase:** 5 · **Epic:** EP-BE-12

---

### BE-117 — WS event emitter helper
**As a** developer **I want** `emit(userId, event, payload)` helper **so that** any module can fan out to dashboard.

**Acceptance criteria**
- Given server-side emit, when called, then connected WS clients receive within 500ms p95.

**Dependencies** — BE-014. **Points:** 3 · **Phase:** 5 · **Epic:** EP-BE-12

---

### BE-118 — Twilio SMS for critical alerts
**As an** operator **I want** SMS escalation for critical-severity events **so that** a muted Telegram or silent hours never hide a kill-switch, reconciliation, or circuit event.

**Acceptance criteria**
- Given a critical event (kill-switch activated, reconciliation mismatch, gRPC circuit open, dead-man trigger, daily DD halt), when fired, then SMS sent via Twilio in addition to Telegram.
- Given warning-severity events, when fired, then **no** SMS (Telegram only) — SMS stays high-signal.
- Given Twilio API failure, when send fails, then failure logged and surfaced on dashboard (alerting-about-alerting).

**Dependencies** — BE-115. **Points:** 3 · **Phase:** 5 · **Epic:** EP-BE-12

---

## EP-BE-13 — Go-live hardening & chaos tests

### BE-120 — Chaos test suite
**As an** operator **I want** chaos tests for kill-switch, DD halt, LLM outage, OANDA disconnect, flash crash **so that** default behaviour is safe.

**Acceptance criteria**
- Given each chaos scenario in plan §15, when run in staging, then safe HOLD/flatten behaviour confirmed.
- Given LLM provider total outage, when all providers fail, then HOLD within timeout budget; no hung jobs.
- Given gRPC quant outage, when circuit opens, then HOLD for all instruments; circuit recovery tested.
- Given flash crash (spread >5× median injected), when detected, then new entries halted; alert fired.
- Given weekend gap scenario in live sim, when pre-Friday flatten enabled, then positions closed before market close.
- Given worst-case load (all configured instruments emit candidates at the same bar close + 2 debate rounds forced + one provider degraded), when run in staging, then every job completes within E2E budget (from semaphore acquisition) with no starved instrument.
- Given Redis flushed while kill-switch active, when workers evaluate, then trading remains halted (BE-073 re-hydration verified).

**Dependencies** — BE-072, BE-073, BE-080, BE-068. **Points:** 8 · **Phase:** 6 · **Epic:** EP-BE-13

---

### BE-121 — Canary sizing ramp + human confirm
**As an** operator **I want** min-lot ramp and human confirm on first N live trades **so that** go-live is graduated.

**Acceptance criteria**
- Given first N live signals, when generated, then one-tap confirm required before execution.

**Dependencies** — BE-101. **Points:** 5 · **Phase:** 6 · **Epic:** EP-BE-13

---

### BE-122 — 90-day paper validation gate
**As an** operator **I want** agents must beat baseline net of LLM cost over 90-day paper **so that** live promotion is evidence-based.

**Acceptance criteria**
- Given paper run complete, when promotion checked, then powered comparison documented; failing gate blocks live.

**Dependencies** — BE-101, QN-060. **Points:** 5 · **Phase:** 6 · **Epic:** EP-BE-13

---

## EP-BE-14 — Compliance, audit & GDPR

### BE-130 — Append-only audit log
**As an** auditor **I want** immutable audit log of state changes and LLM calls **so that** every action is traceable.

**Acceptance criteria**
- Given state change, when occurred, then `audit_log` row appended; no UPDATE/DELETE on table.
- Given `GET /audit`, when queried, then paginated filterable results.

**Dependencies** — BE-013. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-14

---

### BE-131 — Encrypted broker credentials (OANDA)
**As a** security owner **I want** sealed OANDA API credentials **so that** compromise is contained.

**Acceptance criteria**
- Given creds stored, when inspected in DB, then encrypted; decryption only in quant/worker runtime.
- Given OANDA v20 token, when saved via settings, then step-up 2FA required; token never returned in full to frontend.

**Technical notes**
- Phase 1 delivers encrypted storage + runtime decryption (needed by Phase 2 execution); creds seeded via env/CLI until the settings write path (BE-100) and step-up 2FA (BE-036) arrive in Phase 5.

**Dependencies** — BE-021. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-14

---

### BE-132 — GDPR export + erasure endpoints
**As a** user **I want** data export and deletion **so that** I can exercise GDPR rights.

**Acceptance criteria**
- Given export request, when processed, then ZIP of user data with 7-day download link emailed.
- Given erasure request with confirmation, when processed, then user data anonymised per retention policy.

**Dependencies** — BE-130. **Points:** 8 · **Phase:** 5 · **Epic:** EP-BE-14

---

## EP-BE-15 — Observability & deploys

### BE-140 — OpenTelemetry → Grafana/Tempo
**As a** developer **I want** distributed traces across Fastify → workers → gRPC → Python **so that** slow paths are visible.

**Acceptance criteria**
- Given OTEL configured, when request flows, then spans appear for route handlers, BullMQ jobs, gRPC, Prisma.

**Dependencies** — BE-010. **Points:** 5 · **Phase:** 5 · **Epic:** EP-BE-15

---

### BE-141 — Grafana dashboards + alerting thresholds
**As an** operator **I want** operational dashboards with defined alert thresholds **so that** system health issues trigger timely notification.

**Acceptance criteria**
- Given dashboards deployed, when opened, then LLM cost/latency, queue depth, reconciliation status, circuit breaker state panels populated.
- Given LLM p95 latency >30s for 5 min, when alert fires, then Telegram warning sent.
- Given `signals` queue depth >10 for 2 min, when alert fires, then warning sent; >25 triggers critical Telegram + SMS.
- Given gRPC circuit breaker OPEN, when detected, then critical Telegram + SMS.
- Given daily DD >4% (80% of halt), when detected, then warning alert.
- Given monthly LLM cost >85%, when detected, then warning alert.

**Dependencies** — BE-140. **Points:** 8 · **Phase:** 5 · **Epic:** EP-BE-15

---

### BE-142 — Restic nightly backups + weekly restore drill
**As an** operator **I want** off-platform backups with documented recovery SLA **so that** data survives host failure.

**Acceptance criteria**
- Given nightly job, when run, then Postgres dump from the self-hosted TimescaleDB instance to S3-compatible storage; weekly restore drill documented.
- Given restore drill, when executed, then RPO <1h and RTO <4h verified and logged (restore includes hypertables, CAGGs, and pgvector data).
- Given production deploy, when reviewed, then the database runs on its own dedicated volume with its own container lifecycle, not co-located in the application Swarm stack (ADR-006 rev.).

**Dependencies** — BE-006. **Points:** 5 · **Phase:** 1 · **Epic:** EP-BE-15

---

## Definition of Done (applies to every story)

A story is **Done** when all the following are true:

1. Acceptance criteria pass in staging.
2. Unit tests added/updated (Vitest); coverage on new code ≥80%.
3. Integration tests cover handler ↔ DB + handler ↔ gRPC (mocked at boundary).
4. Zod schemas in `@fx/types` for new request/response; Python codegen passes.
5. OpenAPI regenerated; api-client rebuilds without drift.
6. Audit log writes verified for state-changing actions.
7. Sentry + OTel spans cover new code path.
8. Migration backwards-compatible OR ships with feature flag.
9. PR reviewed; no unresolved comments.
