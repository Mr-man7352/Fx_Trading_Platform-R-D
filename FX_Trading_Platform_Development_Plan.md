# FX Trading Platform — Documentation Index



---

## Documents

| Document | Description |
|---|---|
| [PRD](FX_PRD.md) | Product requirements + chronological Phase 1–6 build plan with all FE/BE/QN stories in build order |
| [System Design](system-design/FX_System_Design.md) | Overview, design principles, topology, auth (Google OAuth + email/password), Fastify architecture, data model, brokers, vendors, risk, compliance, roadmap |
| [Architecture Diagram](system-design/FX_Architecture_Diagram.mermaid) | Visual system architecture v2.2 (Mermaid — Fastify, workers, entry gate, LangGraph, quant, safety, data plane); also rendered inline in System Design §2 |
| [Frontend User Stories](FX_Stories_Frontend.md) | Tracker-ready stories (`FE-` prefix) — dashboard, charts, agents, auth UI |
| [Node API User Stories](FX_Stories_NodeAPI.md) | Fastify API, BullMQ workers, LangGraph, auth endpoints, infra (`BE-` prefix) |
| [Python Quant User Stories](FX_Stories_PythonQuant.md) | Quant service, gRPC, backtest, MT5/OANDA adapters (`QN-` prefix) |
| [Plan Review v2.1](FX_Plan_Review_v2.1.md) | Critical review that produced the v2.2 changes — findings, severity, rationale |

---

## Key architecture decisions (v2.2)

- **Auth:** **Google OAuth + email/password** via Auth.js v5; invite-only registration; TOTP 2FA step-up + **recovery codes** for sensitive trading ops.
- **Execution:** **OANDA v20 sole production venue** — REST + streaming, no MT5 terminal dependency (ADR-005). Explicit partial-fill **and rejection** handling.
- **Database:** **Self-hosted PostgreSQL 18 + TimescaleDB (community) + pgvector** on a dedicated volume, outside the Swarm stack (ADR-006 rev. — Neon rejected: Apache-2 TimescaleDB lacks CAGGs/compression/retention).
- **Agents:** First-class **agent memory** with vector retrieval and **outcome-linked reflection on trade close** (§9.5); formal **context contracts** per role with a dedicated **context assembler** (BE-074); domain specialists (parallel); debate depth linked to regime uncertainty; **deterministic entry gate** — agents fire only on quant candidates (ADR-010); PM summary is a **deterministic digest** (ADR-011).
- **Resilience:** **gRPC circuit breaker** (60s cooldown) + per-stage sub-budgets that **sum to the graph budget**; failover capped at one 10s fallback; LangGraph concurrency cap (max 3, E2E clock at semaphore acquisition); **kill-switch state in Postgres** (ADR-012); **off-host dead-man's switch** with own broker token (ADR-013); event-driven **agentic backtest runner** (QN-056).
- **Risk:** P(profitable) threshold **0.60** default; per-instrument daily loss limit; correlation clustering **computed in Python with event-triggered refresh** (QN-048); **DST-aware** session/rollover/Friday-close logic (IANA tz); flash-crash handling.
- **Security:** Adversarial **red-team prompt injection suite** (≥20 patterns) **incl. memory-persistence attacks** mandated in CI.
- **Observability:** Grafana **alerting thresholds** defined (§12.1); critical alerts escalate via **Telegram + Twilio SMS** (BE-118).
- **Unchanged:** BullMQ workers, LangGraph.js agents, Python quant + gRPC, `TRADING_MODE` flag, deterministic risk gate.

*v2.1 incorporated robustness review recommendations; v2.2 incorporates the critical plan review ([findings](FX_Plan_Review_v2.1.md)) · 1 July 2026*

---

*Disclaimer: These documents are engineering and architecture plans, not financial, investment or legal advice. CFDs are high-risk leveraged products.*
