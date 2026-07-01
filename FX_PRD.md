# PRD — FX Swing Trading Platform

**Version 1.0 · 2 July 2026 · Status: Draft for build**
**Owner:** Operator (single-user platform) · **Aligned to:** System Design v2.2, Plan Review v2.1

Companion documents: [System Design](system-design/FX_System_Design.md) · [Architecture Diagram](system-design/FX_Architecture_Diagram.mermaid) · [Frontend Stories](FX_Stories_Frontend.md) · [Node API Stories](FX_Stories_NodeAPI.md) · [Python Quant Stories](FX_Stories_PythonQuant.md) · [Plan Review v2.1](FX_Plan_Review_v2.1.md)

> Full acceptance criteria, technical notes, points, and dependencies for every story live in the three story files. This PRD lists stories with one-line summaries in build order; the story files are the source of truth for detail and version pins.

---

## 1. Overview

An AI-powered FX swing-trading platform (H1 → D1) for FX majors, XAU/USD, and WTI/Brent, inspired by [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) but re-engineered around a measurable quant backbone with real execution, costs, and risk control.

**Problem.** LLM multi-agent trading frameworks like TradingAgents demonstrate promising decision quality but are research toys: no real execution, no cost accounting, no deterministic risk control, no auditability. Discretionary retail FX trading, meanwhile, suffers from inconsistency and emotion.

**Solution.** A three-layer system in which a deterministic Python quant core generates and sizes candidate signals, a LangGraph.js multi-agent LLM layer (analysts → bull/bear debate → trader → risk team → PM) confirms, vetoes, or explains — never sizes — and a deterministic, non-LLM risk gate holds final authority over every order. One `TRADING_MODE` flag (`backtest | paper | live`) drives an identical code path in every mode.

**Scope guardrails.** Single-user / invite-only, own broker account only (OANDA v20 production venue), no pooled money, no monetisation — UK personal/research framing. CFDs are high-risk leveraged products; this is an engineering plan, not financial advice.

## 2. Goals

1. Fully automated H1-cycle swing trading on ~8 instruments with paper and live modes behind a promotion gate.
2. Agent stack must beat the always-on shadow quant baseline **net of LLM cost** over a 90-day paper run before live trading is permitted.
3. Every decision fully auditable and deterministically replayable from stored provenance (`agent_runs`, `debates`, `features`, candle snapshots, `retrieved_memory_ids`).
4. Safety non-negotiables enforced outside the LLM: kill-switch < 2 s (Postgres-backed state), 5% daily-loss halt, 2% per-instrument daily tripwire, correlation-cluster caps, off-host dead-man's switch with its own broker token.
5. Point-in-time discipline everywhere: look-ahead in backtests is a build-breaking defect.

**Non-goals:** multi-tenant SaaS, pooled/managed money, HFT/sub-H1 execution, MT5 as a production venue (optional adapter only, ADR-005), mobile app (responsive web only).

## 3. Success metrics

| Metric | Target |
|---|---|
| 90-day paper: agents vs shadow baseline (net of LLM cost) | Agents > baseline; signed risk report before live |
| Kill-switch latency (signal → broker-confirmed flat) | < 2 s |
| Agent graph E2E worst case (from semaphore acquisition) | < 180 s; per-stage sub-budgets sum ≤ 120 s |
| Decision replay | Any past decision reproduces deterministically |
| Red-team prompt-injection suite (incl. memory-persistence attacks) | ≥ 20 patterns pass in CI |
| Data quality | No look-ahead violations; gap/staleness alerts in Grafana |

## 4. Users

- **Operator (primary):** owns the deployment, monitors dashboard, arms/disarms live mode, holds kill-switch, receives Telegram/SMS alerts.
- **Invited user (later, gated):** connects own broker account under invite-only registration. Hard stop before enabling: UK regulated-activity review (see §11 of System Design).
- **Developer:** builds/extends the platform; needs reproducible local stack, CI, typed contracts.

## 5. Product principles

The eight non-negotiable design principles from System Design §1 apply to every requirement in this PRD, chiefly: quant backbone first / LLM second; single code path across modes; deterministic risk gate holds final authority; full auditability; point-in-time discipline; shadow baseline always on; Node never does maths; invite-only and own-account-only.

## 6. Functional requirements (summary)

| Area | Requirement | Stories |
|---|---|---|
| Market data | OANDA streaming + OANDA-candles backfill (6 mo, incl. XAU_USD; Twelve Data free-tier cross-check) into TimescaleDB hypertables with CAGGs (M5→H4→D1); point-in-time news archive; macro ingest (COT, EIA, FRED); data-quality monitor | BE-040…045, QN-020…022 |
| Quant core | Point-in-time features, DST-aware session/rollover/gap features, HMM regime + liquidity regime, LightGBM meta-model with calibration, vol-targeted sizing + fractional-Kelly cap, shadow baseline, champion/challenger, correlation clustering (Python, event-triggered) | QN-040…048 |
| Agents | LangGraph.js graph: parallel domain specialists → bull/bear debate (depth linked to regime uncertainty) → trader → risk team → deterministic PM digest; provider factory with capped failover; prompt registry; context contracts + assembler; outcome-linked agent memory (pgvector); deterministic entry gate — graph fires only on quant candidates | BE-060…069, BE-074 |
| Risk | Deterministic rule engine; correlation cap consuming QN-048 clusters; kill-switch API with Postgres source of truth; P(profitable) ≥ 0.60 entry threshold | BE-070…073 |
| Execution | OANDA v20 order lifecycle incl. partial fills and rejection reason codes; trailing/breakeven/partial-close manager; 60 s reconciler; off-host dead-man's switch | BE-050…054, QN-030…034 |
| Supervision | Deterministic-gated supervision worker; layered exit system | BE-080, BE-081 |
| Backtesting | vectorbt quant-core engine; event-driven agentic runner (same LangGraph code path); three execution modes; purged/embargoed OOS; ablation harness; replay | QN-050…056, QN-062, BE-090 |
| Auth | Google OAuth + email/password (Auth.js v5), invite codes, TOTP 2FA step-up + recovery codes, account linking | BE-030…037, FE-030…036 |
| Dashboard | Operator home, system-health strip (circuit breaker, regimes, downgrade flags), charts, live debate viewer, trades with provenance, backtest UI, quant analytics, settings, calendar, audit viewer | FE-040…131 |
| Notifications | Telegram trade events, Resend email digests, WS fanout, Twilio SMS for critical alerts | BE-115…118 |
| Compliance | Append-only audit log, encrypted broker creds, GDPR export/erasure, CFD risk disclaimers | BE-130…132, FE-110/111 |

## 7. Non-functional requirements

Resilience: gRPC circuit breaker (Node→Python, 60 s cooldown), one 10 s-capped LLM failover attempt, per-stage sub-budgets with stage-level HOLD on overrun, LangGraph concurrency cap 3 with E2E clock at semaphore acquisition, Redis AOF `everysec`. Security: invite-only, 2FA step-up on trading ops, encrypted creds, red-team CI suite. Observability: OpenTelemetry → Grafana/Tempo, alert thresholds with Telegram + SMS escalation, restic nightly backups + weekly restore drill. Infra: single-node Hetzner Swarm; self-hosted PG18 + TimescaleDB community + pgvector on a dedicated volume outside the stack (ADR-006 rev.).

---

## 8. Development plan — chronological steps and user stories

Six phases, sequenced by dependency (see System Design §14). Within each phase, stories are listed in recommended build order. Epics marked *cross-cutting* run continuously from Phase 1. Format: `ID — one-liner`.

### Phase 1 — Foundation

**Outcome:** monorepo + local stack + CI/CD + mode flag; live candles flowing into TimescaleDB. Phase 1 API auth uses an internal service token stand-in (see BE-013 note); broker creds seeded via env/CLI (BE-131 note). All user-facing auth (UI + API) lands in Phase 5.

**Step 1.1 — Monorepo & shared packages**

- FE-001 — Bootstrap Turborepo + pnpm workspace.
- FE-003 — Shared `packages/tsconfig` + Biome config.
- FE-004 — Shared `packages/types` with Zod 4 (source of truth for contracts).
- FE-002 — Scaffold Next.js 16 dashboard app.
- FE-005 — Shared `packages/api-client`.
- FE-006 — Shared `packages/auth-client`.
- BE-001 — Bootstrap `apis/node-api` workspace.
- BE-002 — Typed env loader with Zod (fail-fast config).
- BE-003 — `TRADING_MODE` flag wired globally (`backtest|paper|live`).

**Step 1.2 — Local stack, CI/CD, deploy**

- BE-004 — Docker Compose local stack (PG18+TimescaleDB, Redis, quant, api, web).
- FE-007 — `pnpm dev` boots all services locally.
- BE-005 — CI pipeline (lint, test, build, GHCR publish).
- BE-006 — Zero-downtime deploy to Hetzner Swarm.

**Step 1.3 — Fastify bootstrap**

- BE-010 — Fastify server bootstrap with Pino logging.
- BE-011 — Helmet, CORS, rate-limit plugins.
- BE-012 — Zod-validated routes.
- BE-013 — Request context + audit middleware (internal-token auth stand-in until Phase 5).
- BE-014 — WebSocket gateway.
- BE-015 — OpenAPI + Swagger UI.

**Step 1.4 — Database schema**

- BE-020 — TimescaleDB hypertables + continuous aggregates + retention (self-hosted community edition, ADR-006 rev.).
- BE-021 — Prisma schema for MVP entities.
- BE-022 — Migration pipeline + safety checks.
- BE-023 — Dev seed scripts.
- BE-131 — Encrypted broker credentials: storage + runtime decryption (settings write path arrives Phase 5).

**Step 1.5 — Quant service scaffold**

- QN-001 — Quant service scaffold (`services/quant`).
- QN-002 — Shared `fx_common` library.
- QN-003 — Pydantic codegen from `@fx/types` JSON Schema.
- QN-004 — gRPC service definitions (Pipeline, SizePosition, Predict).
- QN-005 — Quant Dockerfile + deploy config.

**Step 1.6 — Market data ingestion**

- QN-020 — OANDA streaming feed adapter (connection/auth/stream only; execution adapter is Phase 2 — per Plan Review §6).
- QN-021 — OANDA historical backfill + vendor cross-check.
- QN-022 — FinBERT point-in-time sentiment scoring.
- BE-040 — Market-data BullMQ worker.
- BE-041 — Vendor adapter interface + backfill.
- BE-042 — Point-in-time news archive API.
- BE-043 — Macro features ingest (COT, EIA, FRED).
- BE-044 — Data-quality monitor.
- BE-045 — Market REST endpoints (candles, instruments).

**Step 1.7 — Design system**

- FE-010 — Tailwind v4 + shadcn in `packages/ui`.
- FE-011 — Trading-specific compositions.

**Cross-cutting from Phase 1:** BE-140 (OpenTelemetry → Grafana/Tempo), BE-141 (dashboards + alert thresholds), BE-142 (restic backups + restore drill), BE-130 (append-only audit log), FE-110 (CFD disclaimers), FE-111 (invite-only messaging).

**Exit criteria:** compose stack green in CI; live OANDA candles queryable via BE-045; deploy pipeline proven.

### Phase 2 — Execution & Quant

**Outcome:** orders execute on OANDA (paper); deterministic quant core produces sized candidates; shadow baseline running.

**Step 2.1 — Broker abstraction & execution adapters**

- QN-030 — Typed BrokerAdapter interface.
- QN-032 — OANDA v20 adapter (primary execution venue, ADR-005).
- QN-033 — Symbol mapping table.
- QN-034 — Cross-currency pip/lot/margin module.
- QN-031 — MT5 adapter (optional, off critical path; interface conformance via mock in CI).

**Step 2.2 — Order lifecycle & reconciliation**

- BE-050 — Execution worker + order lifecycle, incl. partial fills and REJECTED / INSUFFICIENT_MARGIN / MARKET_HALTED reason codes.
- BE-051 — Trailing stop, partial close, breakeven manager.
- BE-052 — Reconciler (60 s broker ↔ DB).
- BE-053 — Dead-man's switch: off-host watchdog with own scoped OANDA token (ADR-013).
- BE-054 — Trades REST endpoints.

**Step 2.3 — Deterministic quant core**

- QN-040 — Point-in-time feature pipeline.
- QN-047 — DST-aware session, rollover, and gap-risk features (IANA tz).
- QN-041 — Regime detection (HMM) + liquidity regime.
- QN-043 — LightGBM meta-model + calibration.
- QN-042 — Vol-targeted sizing + fractional-Kelly cap.
- QN-044 — Probability-modulated sizing (optional flag).
- QN-045 — Shadow quant baseline (always on).
- QN-046 — Champion/challenger promotion + drift monitor.
- QN-048 — Correlation clustering computation + event-triggered refresh (Python owns the maths).

**Exit criteria:** paper orders round-trip on OANDA with reconciler clean; quant pipeline emits calibrated, sized candidates; baseline logging P&L.

### Phase 3 — Intelligence

**Outcome:** multi-agent stack confirms/vetoes quant candidates; deterministic risk gate + kill-switch < 2 s.

**Step 3.1 — LLM plumbing**

- BE-060 — LLM provider factory + failover (one fallback attempt, 10 s cap).
- BE-061 — Prompt registry + model snapshot pinning.
- BE-068 — gRPC circuit breaker (Node → Python).
- BE-069 — Agent context contracts in `@fx/types`.

**Step 3.2 — Agent graph**

- BE-074 — Context assembler (headlines, memories, feature partitions; validates contracts pre-invocation).
- BE-062 — LangGraph domain specialists (parallel) + debate + consensus; deterministic PM digest (ADR-011).
- BE-064 — Agent memory with vector retrieval; outcome-linked reflection on trade close; hygiene + embedding versioning; `retrieved_memory_ids` stored.
- BE-063 — Prompt-injection hardening + red-team suite (≥ 20 patterns incl. memory-persistence attacks) in CI.
- BE-065 — Disagreement cohort logging.
- BE-066 — Signals worker: deterministic entry gate (graph fires only on quant candidates, ADR-010), per-stage sub-budgets, concurrency cap 3.
- BE-067 — Signals REST + WS fanout.

**Step 3.3 — Risk gate & kill-switch**

- BE-070 — `packages/risk-gate` rule engine (final authority; P ≥ 0.60, daily-loss halts, DST-aware Friday close).
- BE-071 — Correlation clustering cap (consumes QN-048 clusters).
- BE-072 — Master kill-switch API (< 2 s; step-up 2FA activates when BE-036 lands).
- BE-073 — Kill-switch state persistence: Postgres source of truth, Redis cache, close-out partial-failure handling (ADR-012).

**Exit criteria:** end-to-end paper cycle bar-close → gate → agents → risk gate → order; kill-switch flattens broker-confirmed in < 2 s; red-team suite green.

### Phase 4 — Lifecycle

**Outcome:** open trades supervised; reproducible backtests incl. agentic runs.

**Step 4.1 — Supervision**

- BE-080 — Supervision queue + deterministic gate (LLM only on material change).
- BE-081 — Layered exit system.

**Step 4.2 — Backtesting & validation harness**

- QN-050 — vectorbt backtest engine (quant-core path).
- QN-051 — Point-in-time news/sentiment in backtests.
- QN-056 — Event-driven agentic backtest runner (incremental deterministic memory; same LangGraph code path; reconciles vs vectorbt).
- QN-052 — Three execution modes (quant-only, cached-LLM, live-LLM).
- QN-053 — Purged/embargoed OOS validation suite.
- QN-054 — Ablation harness (memory on/off, debate-depth sweep).
- QN-055 — REST endpoints for calibration & regime.
- BE-090 — Backtest trigger + results API.
- FE-080 — Backtest config + results UI.

**Exit criteria:** a backtest replays deterministically; agentic runner matches quant core on the quant-only path; ablations runnable.

### Phase 5 — Surface

**Outcome:** full auth, dashboard, settings, and notifications; operator can run the platform without touching a terminal.

**Step 5.1 — Auth backend + 2FA**

- BE-030 — NextAuth JWT verification middleware (replaces the Phase 1 stand-in behind the same `RequestContext`).
- BE-031 — User upsert on sign-in.
- BE-032 / BE-033 — Email/password registration + login.
- BE-034 — Email verification + password reset tokens.
- BE-035 — Invite code validation + CRUD.
- BE-036 — TOTP 2FA enroll/verify + step-up flag + recovery codes.
- BE-037 — Account linking (Google ↔ credentials).
- FE-030 — Google OAuth sign-in (NextAuth v5).
- FE-031 — Email/password registration with invite code.
- FE-032 — Email/password sign-in.
- FE-033 — Forgot password + reset flow.
- FE-034 — Email verification pending UX.
- FE-035 — TOTP 2FA enrollment + step-up modal (+ recovery codes).
- FE-036 — Account settings (link Google, change password).

**Step 5.2 — Dashboard**

- FE-041 — AppShell navigation.
- FE-040 — Operator home (`/dashboard`).
- FE-042 — System health strip (circuit breaker, liquidity regime, session labels, `model_downgraded`, gap-flatten arming — v2.2 machinery).
- FE-050 — Charts page (Lightweight Charts).
- FE-060 — Live agent debate viewer (incl. debate depth + memory inspection).
- FE-070 — Trades history with provenance.
- FE-090 — Quant dashboard (calibration, regimes).
- FE-100 — Settings page (risk params, clustering, session multipliers, per-instrument limits).
- FE-101 — Economic calendar.
- FE-102 — Audit log viewer.

**Step 5.3 — Settings & notifications backend**

- BE-100 — Settings CRUD API.
- BE-101 — Live-promotion gate.
- BE-110 — Economic calendar service.
- BE-115 — Telegram bot for trade events.
- BE-116 — Resend email digests.
- BE-117 — WS event emitter helper.
- BE-118 — Twilio SMS for critical alerts.

**Step 5.4 — Realtime, polish, accessibility**

- FE-120 — WebSocket subscription + toasts (incl. partial-fill notifications).
- FE-121 — Graceful error states.
- FE-130 — Mobile-first safety controls (kill-switch reachable on phone).
- FE-131 — WCAG 2.2 AA on core flows.

**Exit criteria:** operator completes full workflow (sign-in → arm paper → observe debate → kill-switch) from the dashboard, with alerts firing.

### Phase 6 — Go-live

**Outcome:** hardened system passes chaos tests and the 90-day paper gate; signed promotion to live.

- BE-120 — Chaos test suite (incl. worst case: all instruments candidate + 2-round debates + one degraded provider, E2E < 180 s).
- BE-121 — Canary sizing ramp + human confirm.
- QN-060 — 90-day paper vs baseline validator (net of LLM cost; downgraded-bar tolerance policy).
- QN-061 — Signed risk report generator.
- QN-062 — Decision replay from provenance.
- BE-122 — 90-day paper validation gate → live.
- BE-132 — GDPR export + erasure endpoints (complete before any invited user).

**Exit criteria:** chaos suite green; paper run beats baseline net of cost; signed report produced; live mode enabled via canary ramp with human confirmation.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| LLM cost/latency blow-up | Deterministic entry gate (ADR-010); per-stage sub-budgets; supervision gating (BE-080); prompt-cache limits acknowledged for agentic backtests |
| Provider outage during paper window | Failover chain + downgraded-bar tolerance policy (QN-060) |
| Prompt injection / memory poisoning | Red-team CI suite incl. memory-persistence attacks (BE-063); untrusted-data isolation in context contracts |
| Host loss with open positions | Off-host dead-man's switch with own broker token (BE-053, ADR-013) |
| Self-reinforcing agent memory | Outcome-linked reflections, dedup/decay, embedding pinning (BE-064) |
| Look-ahead bias | Point-in-time enforcement everywhere; build-breaking defect policy; purged/embargoed OOS (QN-053) |
| Regulatory scope creep (UK) | Own-account-only, invite-only; hard stop + legal review before any second user connects a broker |

## 10. Open questions

Tracked in System Design §16. Notable: second-user regulatory review timing; MT5 adapter Windows test environment (descoped to mock conformance); Timescale storage sizing after 12 months of ticks.
