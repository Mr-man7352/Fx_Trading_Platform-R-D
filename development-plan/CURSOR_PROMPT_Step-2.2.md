# Cursor Agent Prompt — Step 2.2: Order lifecycle & reconciliation (BE-050, BE-051, BE-052, BE-053)

Copy everything below the line into the Cursor agent.

---

You are implementing **Step 2.2 — Order lifecycle & reconciliation** of Phase 2 in this FX trading platform monorepo. Stories in scope: **BE-050 (execution worker + order lifecycle), BE-051 (trailing/partial/breakeven manager), BE-052 (60s reconciler), BE-053 (off-host dead-man's switch, ADR-013)**. BE-054 (trades REST) is explicitly **out of scope** (deferred to Phase 5).

## Read these first (in order)

1. `CLAUDE.md` — repo protocols. **Never handwrite Prisma migration files** — change `schema.prisma` and run `pnpm --filter @fx/node-api exec prisma migrate dev`. If a generation script fails, stop and ask the operator; do not fabricate generated output.
2. `development-plan/DEVLOG-phase2.md` — current state, standing decisions, conventions. **You must append a new entry and update "Current state" when done** (template at bottom of that file).
3. `development-plan/FX_Stories_NodeAPI.md` — EP-BE-6 section: exact acceptance criteria for BE-050…053. The ACs are the contract; implement to them.
4. `development-plan/system-design/FX_System_Design.md` — §2.1 decision flow, §5.4 queues, §6 quant service, §8 partial-fill rules, ADR-005/013.
5. Existing code seams:
   - `services/quant/app/execution/` — Step 2.1's `BrokerAdapter` protocol (`adapter.py`), OANDA adapter (`oanda_adapter.py`), models, symbols, sizing, credentials. **This is the only code that talks to OANDA. Do not duplicate broker logic in Node.**
   - `services/quant/proto/quant.proto`, `app/grpc/server.py`, `app/grpc/servicer.py` — existing gRPC service.
   - `apis/node-api/src/workers/` — `queues.ts`, `market-data.ts`, `main.ts` (BullMQ patterns to follow).
   - `apis/node-api/prisma/schema.prisma` — `TradeIntent`, `Trade`, `IntentStatus`, `TradeStatus`, `AuditLog` already exist.
   - `apis/node-api/src/events.ts` — WS event bus (`publish(channel, payload)`).
   - `packages/types/src/broker.ts` — shared broker contracts from QN-030.

## Ground rules (standing decisions — do not re-litigate)

- OANDA v20 is the **sole** venue (QN-031/MT5 dropped). Keep the adapter seam venue-agnostic; no OANDA specifics outside `services/quant/app/execution/`.
- `TRADING_MODE` (`backtest|paper|live`): one identical code path. Every new env key goes into fail-fast Zod in `apis/node-api/src/env.ts` **and** `.env.example` (CI checks). Python config keys go in `services/quant/app/config.py`.
- Quant service: uv-managed Python 3.13; REST `:5001`, gRPC `:50051`. Generated code (`app/contracts/`, `app/proto_gen/`) is committed and drift-checked — regenerate via `scripts/gen_contracts.py` / `scripts/gen_proto.py`, never hand-edit.
- Rejects are **results, not exceptions** (adapter convention); only transport failures raise `BrokerError`.
- Story IDs in code comments and commit messages. **Do not `git commit` unless the operator asks.**
- Tests: Vitest (Node), pytest (Python). Follow existing patterns (`FakeOanda` MockTransport in `services/quant/tests/execution/`).

## Architecture decision for this step (follow it)

Node owns **orchestration and persistence**; Python owns **broker I/O**. Bridge them with a new gRPC `ExecutionService` in `quant.proto` (consistent with ADR-004; the channel and health-check plumbing already exist):

```proto
service ExecutionService {
  rpc PlaceOrder(PlaceOrderRequest) returns (PlaceOrderResponse);       // wraps adapter.place_order; client_id = intent UUID (idempotency)
  rpc CloseTrade(CloseTradeRequest) returns (CloseTradeResponse);       // full or partial (units)
  rpc ModifyTrade(ModifyTradeRequest) returns (ModifyTradeResponse);    // amend SL/TP on an open broker trade
  rpc ListOpenPositions(ListOpenPositionsRequest) returns (ListOpenPositionsResponse);
  rpc GetTransactions(GetTransactionsRequest) returns (GetTransactionsResponse); // since-txn-id, for reconciler fill/close sync
}
```

- Servicer lives in `app/grpc/` and delegates to the Step-2.1 adapter (loaded via `credentials.py` + `ADAPTER_FACTORIES`). Broker rejects map to a structured response (`status=REJECTED`, `reason_code`), **never** a gRPC error; only transport/config failures produce gRPC errors.
- Node gets a thin typed client in `apis/node-api/src/execution/quant-client.ts` with a hard timeout (10s place/close, 5s reads) — timeout/UNAVAILABLE is treated as "unknown outcome" (see BE-050). The full BE-068 circuit breaker is Phase 3; do not build it now.
- If `ModifyTrade`/`GetTransactions` need small additions to the Python adapter protocol + `FakeOanda`, make them, keep the conformance suite green, and extend it to cover the new methods.

## Work items, in order

### 0. Execution seam (prerequisite)

Proto messages + servicer + Node client as above. Regenerate proto/contracts via the scripts (ask the operator to run them if the environment can't). Unit-test the servicer against `FakeOanda`; unit-test the Node client against a stubbed gRPC server.

### 1. BE-050 — Execution worker + order lifecycle (8 pts)

New `apis/node-api/src/workers/execution.ts` consuming the `execution` queue (add queue names/payloads to `queues.ts`; producer today is a dev script — see below — and later the Phase-3 signals worker).

- **Input:** `{ intentId }`. Load `TradeIntent` (must be `approved`), transition to `submitted`, call `PlaceOrder` with `client_id = intent.id` and broker-side SL/TP from the intent.
- **Idempotency AC:** BullMQ retry or duplicate job with the same intent UUID must not double-order — the OANDA adapter already recovers the original fill on duplicate; the worker must also be idempotent DB-side (upsert `Trade` on `intentId`, unique).
- **Fill:** persist `Trade` (`brokerTradeId`, `brokerOrderId`, real fill price, units, `openedAt`), intent → terminal state, enqueue `supervision` job (queue exists in design §5.4; create the queue constant, consumer is Phase 3), publish WS `trade.fill`, write `audit_log` row.
- **Partial fill AC:** accept the filled portion, log remainder in `Trade.meta` + audit row, **no same-bar auto-retry**, notify operator (WS + notification, below).
- **Rejection AC:** map `REJECTED` / `INSUFFICIENT_MARGIN` / `MARKET_HALTED` / other broker codes onto the intent (`rejected` + reason code in a new column or `riskGate`-style JSON — prefer a `reasonCode String?` column on `TradeIntent`; schema change via `prisma migrate dev`, never a handwritten migration). No retry storm: broker rejects are terminal, job completes (BullMQ must not retry them).
- **Unknown outcome** (gRPC timeout after send): do NOT assume failure — mark intent `submitted` and let the reconciler resolve it; audit row with reason `unknown_outcome`.
- **Halt check:** before placing, check a shared halt flag (Redis key `execution:halt`, small helper module) — if set, mark intent `cancelled` with reason `halted`, audit, no order.
- **Notifications:** minimal seam only (full Telegram bot is BE-115/Phase 5): `notifications` queue + tiny worker that logs, and sends Telegram via bot HTTP API iff `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (optional env keys, no-op otherwise).
- **Dev trigger:** `scripts/enqueue-intent.ts` (or a `pnpm` script) that creates an approved paper-mode `TradeIntent` from CLI args and enqueues an execution job — needed for the Phase-2 exit criterion (paper round-trip) before the Phase-3 signal worker exists.

### 2. BE-051 — Trailing stop, partial close, breakeven manager (5 pts)

`apis/node-api/src/workers/trade-manager.ts`, BullMQ repeatable job every **30s** (skip when `TRADING_MODE=backtest` or halt flag set).

- For each open `Trade`: compute R-multiple from entry vs original SL (persist original risk distance at fill time — add to `Trade.meta` in BE-050).
- At **+1R** (config): partial close (default 50%) via `CloseTrade`, move SL to breakeven (entry ± small buffer) via `ModifyTrade`. Do each action **once** — persist manager state on `Trade.meta` (`partialTakenAt`, `breakevenSetAt`, `trailActive`).
- Trailing: after breakeven, trail SL by a configured distance (ATR-based is Phase-3 polish; a fixed pip/fraction-of-R distance from config is fine now). **Never widen SL** — enforce and unit-test.
- Config: typed module `apis/node-api/src/execution/manager-config.ts` with env-overridable defaults (`+1R` trigger, partial fraction, breakeven buffer, trail distance); document keys in `.env.example`.
- Current price: reuse the market-data plane (latest tick/candle from DB or Redis — follow whatever BE-040 already stores); do not open a second broker pricing path.

### 3. BE-052 — Reconciler, 60s broker ↔ DB (5 pts)

Repeatable job (60s) on the `reconciliation` queue, consumed by the execution worker process (design §5.4).

- Pull broker state via `ListOpenPositions` + `GetTransactions(sinceTxnId)` (persist high-water txn id, e.g. small `reconciler_state` row or Redis).
- **Expected transitions — sync silently:** broker-side SL/TP closes → close the DB `Trade` (exit price, realized P&L incl. swap/commission from transactions), publish WS `pnl.update`; fills for `submitted` intents that lost their gRPC response → complete BE-050's persistence path.
- **True mismatches — act:** unknown broker position (no DB trade), size drift, DB-open trade missing at broker with no closing transaction. AC: configured action `RECONCILE_ACTION=flatten_and_halt|halt` (env, default `halt`): set the halt flag, publish WS `reconciliation.mismatch` + `risk.halt`, audit row, notification; `flatten_and_halt` additionally closes all open broker trades via `CloseTrade` before halting.
- Halt is sticky — cleared manually (document: `redis-cli DEL execution:halt` for now; operator UI is later).
- **AC test:** inject a mismatch (fake broker state vs DB) in a Vitest integration-style test and assert action + alert fire.

### 4. BE-053 — Dead-man's switch / off-host watchdog (5 pts, ADR-013)

New standalone workspace `workers/watchdog/` — **minimal and fate-isolated**: its own `package.json`, near-zero deps, no imports from `@fx/*` packages or the DB, talks only to (a) the platform heartbeat URL and (b) the OANDA REST API with **its own token**.

- Loop: poll `GET {PLATFORM_HEARTBEAT_URL}` (the existing node-api `/healthz` is acceptable; if it doesn't reflect worker liveness, add a lightweight `/healthz/heartbeat` that also checks the execution worker's last-seen timestamp in Redis). On `WATCHDOG_TIMEOUT` consecutive failures (configurable window, default e.g. 3 misses × 60s), **flatten all open positions directly via OANDA REST** (`PUT /v3/accounts/{id}/positions/{instrument}/close`) using `WATCHDOG_OANDA_TOKEN` — never via the platform. Retry closes with backoff until broker-confirmed flat; alert Telegram (+ SMS if Twilio env present) on trigger and on each retry.
- Token scoping AC: document in `workers/watchdog/README.md` that the token must be a **separate OANDA personal access token stored only on the watchdog host** (OANDA tokens aren't permission-scoped, so the compensating controls are: separate token, revocable independently, held off-host, code path physically incapable of opening positions — assert no order-create endpoint is ever called; unit-test this).
- Dead-man's-dead-man: expose `GET /healthz` on the watchdog itself + README instructions for an external uptime check (e.g. UptimeRobot/healthchecks.io ping).
- Ship a `Dockerfile` + `workers/watchdog/README.md` deploy runbook (separate provider/region from the Hetzner host — deployment itself is an operator action, not yours).
- Tests: fake heartbeat + fake OANDA HTTP server; assert trigger timing, flatten calls, retry-until-flat, and that no position-opening endpoint is reachable.

## Cross-cutting requirements

- **WS events:** use the existing `events.ts` bus; event names per design §5.3: `trade.fill`, `pnl.update`, `risk.halt`, `reconciliation.mismatch`.
- **Audit:** every state transition (submit, fill, partial, reject, halt, reconcile-sync, watchdog config) writes `audit_log`.
- **Metrics:** emit/update Prometheus metrics on the existing `/metrics` endpoint using the **reserved names contracted in `infra/observability/README.md`** (read it; if execution/reconciler metric names are reserved there, match them exactly — the BE-141 alert rules reference them).
- **OTel:** new workers run inside node-api's existing SDK; give BullMQ processors spans consistent with `market-data.ts`.
- **New env keys** (all in `env.ts` Zod + `.env.example` + compose where relevant): `RECONCILE_ACTION`, manager config overrides, `TELEGRAM_BOT_TOKEN?`, `TELEGRAM_CHAT_ID?`; watchdog has its own `.env.example` (`WATCHDOG_OANDA_TOKEN`, `OANDA_ACCOUNT_ID`, `PLATFORM_HEARTBEAT_URL`, timeout knobs).

## Non-goals (do not build)

BE-054 trades REST (Phase 5) · BE-068 gRPC circuit breaker (Phase 3; plain timeouts only) · LLM supervision consumer (queue producer only) · MT5/second venue · operator UI for halt clear · full Telegram bot (BE-115).

## Verification gates (run all; report anything you can't run)

1. `pnpm typecheck && pnpm lint && pnpm test` at root.
2. `pnpm --filter @fx/node-api exec prisma migrate dev` for any schema change (never handwrite migration SQL; destructive SQL needs `-- destructive-ok: <reason>`).
3. `pnpm --filter @fx/types build` + `cd services/quant && uv run python scripts/gen_contracts.py && uv run python scripts/gen_proto.py` if proto/contracts changed (drift check must pass).
4. `cd services/quant && uv run pytest` — conformance suite must stay green, including new ExecutionService coverage.
5. End-to-end paper smoke (document exact commands in the devlog entry): `scripts/enqueue-intent.ts` → fill persisted → trade-manager tick → reconciler clean pass. Against `FakeOanda`/stub if no practice-account creds are available; note it as NOT verified against real OANDA.
6. Append the DEVLOG entry (template at file bottom) and update its "Current state" section: Step 2.2 done, next Step 2.3 (QN-040…048). List any pending human actions (installs, regen scripts, practice-account round-trip).

Work story by story in the order above; keep each story's tests green before moving on. If an acceptance criterion conflicts with something in the codebase, stop and ask rather than guessing.
