# BE-053 — Off-host dead-man's switch (ADR-013)

Fate-isolated process that polls the platform heartbeat and flattens all OANDA
positions directly via REST if the main stack goes silent. Deploy on **separate
infrastructure** (different provider/region from the Hetzner host).

## Token scoping (compensating controls)

OANDA personal access tokens are not permission-scoped. Compensating controls:

1. **Separate token** — `WATCHDOG_OANDA_TOKEN` is a distinct PAT stored only on
   the watchdog host (never in the main stack `.env`).
2. **Revocable independently** — revoke via OANDA account settings without
   touching production trading credentials.
3. **Off-host** — watchdog VM/container cannot share fate with the Swarm host.
4. **Code path** — this service only calls position **close** and **read**
   endpoints; `assertNoOrderCreate` blocks any order-create URL (unit-tested).

## Deploy runbook

```sh
cd workers/watchdog
cp .env.example .env   # fill PLATFORM_HEARTBEAT_URL + OANDA creds
pnpm install && pnpm build
pnpm start             # or docker build -t fx-watchdog . && docker run --env-file .env -p 4100:4100 fx-watchdog
```

Set `PLATFORM_HEARTBEAT_URL` to the public API heartbeat, e.g.
`https://api.<domain>/healthz/heartbeat` (checks execution worker Redis heartbeat).

## Heartbeat semantics

- `ok` → healthy; miss counter resets and the trigger re-arms (a recovered
  host that dies again is still protected).
- `degraded` → API up but the execution worker is silent (>120 s): positions
  are unmanaged though broker-side SL/TP still stand. The watchdog **alerts
  once** (Telegram/SMS) but does NOT flatten — investigate immediately.
- unreachable / non-ok → counts toward `WATCHDOG_TIMEOUT_MISSES` consecutive
  misses; on the threshold the watchdog flattens ALL positions via OANDA REST
  and retries with backoff until the broker confirms flat.

This package is deliberately **dependency-free** (`dependencies: {}` — env
parsing is hand-rolled, no zod): the isolated Docker build copies only this
directory, so a hoisted monorepo dependency would break it.

## Dead-man's-dead-man

Expose `GET http://<watchdog-host>:4100/healthz` to an external uptime checker
(UptimeRobot, healthchecks.io). Alert if the watchdog itself stops responding.

## Clear execution halt (main stack)

When reconciliation halts trading: `redis-cli DEL execution:halt` (operator UI later).
