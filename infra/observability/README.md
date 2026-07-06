# Observability (BE-140 / BE-141)

Tracing + metrics + dashboards + alerting for the platform. Runs locally as an
opt-in compose profile; the same configs deploy to the prod host.

## Quick start (local)

```sh
docker compose -f infra/docker-compose.local.yml --profile observability up -d
# then enable tracing and restart the app services:
#   .env → OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318      (compose services)
#          OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  (bare `pnpm dev`)
```

| UI | URL |
|---|---|
| Grafana (dashboards, alerts, traces) | http://localhost:3001 — admin / `GRAFANA_ADMIN_PASSWORD` (default `admin`) |
| Prometheus | http://localhost:9090 |
| Tempo (queried via Grafana Explore) | http://localhost:3200 |

## How tracing is wired (BE-140)

- **node-api / worker** — `apis/node-api/src/otel.ts`, loaded via `node --import`
  (see package.json `start*`). Auto-instruments HTTP/Fastify, ioredis, pg,
  @grpc/grpc-js + `@prisma/instrumentation`; BullMQ jobs via BullMQ's native
  telemetry hook (`bullmq-otel`) attached in `workers/market-data.ts`.
- **quant** — `services/quant/app/telemetry.py`: FastAPI, grpc.aio server,
  httpx (OANDA calls). W3C traceparent propagates Node → gRPC → Python, so a
  signal evaluation shows as ONE trace: route → job → gRPC → quant → OANDA.
- Everything is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.

## Metric-name contract (BE-141)

`GET /metrics` on node-api (public route, hand-rolled exposition) is the scrape
target. Live today: `fx_queue_jobs{queue,state}`, `fx_build_info`,
`fx_metrics_up`. The following names are RESERVED — the owning story must emit
exactly these, since dashboards + alert rules are already provisioned on them:

| Metric | Type | Owner (story) |
|---|---|---|
| `fx_llm_latency_seconds` | histogram | LLM debate pipeline (BE-06x, Phase 3) |
| `fx_llm_month_cost_usd`, `fx_llm_month_budget_usd` | gauge | LLM cost tracker (Phase 3) |
| `fx_grpc_circuit_breaker_state` (0 closed / 1 half / 2 open) | gauge | BE-068 breaker (Phase 2) |
| `fx_reconciliation_mismatches_total` | counter | BE-053 reconciler (Phase 2) |
| `fx_daily_drawdown_pct` | gauge | risk core (Phase 2/3) |

## Alert thresholds (BE-141 AC)

| Rule | Threshold | Severity → route |
|---|---|---|
| Signals queue depth | >10 for 2m | warning → Telegram |
| Signals queue depth | >25 for 1m | **critical → Telegram + SMS** |
| LLM p95 latency | >30s for 5m | warning → Telegram |
| gRPC circuit breaker | OPEN | **critical → Telegram + SMS** |
| Daily drawdown | >4% (80% of 5% halt) | warning → Telegram |
| Monthly LLM cost | >85% of budget | warning → Telegram |

Rules on not-yet-emitted metrics sit in *NoData* (configured silent) until the
owning story lands — they need no re-provisioning.

Notification secrets (all optional; alerts still show in Grafana without them):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (BotFather bot + target chat), and
`SMS_WEBHOOK_URL` (any HTTP→SMS bridge, e.g. a Twilio function).

## Production

Run the same three containers on the app host (or a monitoring host) and point
`OTEL_EXPORTER_OTLP_ENDPOINT` at Tempo from the Swarm stack env. Prometheus
scrape target becomes the api service on the overlay network. Give Tempo/
Prometheus dedicated volumes; retention defaults (7d traces / 15d metrics) are
set in `tempo.yml` / the compose command. Grafana admin password and alert
secrets come from the deploy env, never committed.
