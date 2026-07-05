# Step 1.6 — Your setup & run guide (Market data ingestion)

Everything for Step 1.6 was built **mock-first**: it compiles and the logic is
tested, but a few things only *you* can do (install packages, supply real API
keys, run against Docker). This is your checklist. Companion refs:
[`COMMANDS.md`](../COMMANDS.md) (daily driver) and
[`DEVLOG.md`](DEVLOG.md) (what changed + why).

> Commit: `e1b44b8` (Step 1.6) on top of `c909a00` (Step 1.5). Both are committed.

---

## 0. TL;DR — do these in order

1. `corepack enable && pnpm install` — pulls the new `bullmq` + `ioredis`.
2. `cd services/quant && uv lock && uv sync` — re-lock Python (httpx is now a
   runtime dep). For FinBERT later: `uv sync --group ml`.
3. Get API keys (Section 2) and put them in `.env` (Section 3). **Optional** —
   without them the pipeline runs in mock/no-op mode.
4. Run it (Section 4) and verify (Section 5).

---

## 1. Finish the install (one-time)

These couldn't run in the assistant sandbox (the mounted folder blocks package
installs and the checked-in `node_modules` is macOS-arm64), so run them locally:

```bash
corepack enable          # pnpm 9, pinned in package.json
pnpm install             # installs bullmq + ioredis (new in Step 1.6) + everything else

cd services/quant
uv lock                  # regenerate uv.lock — httpx moved to runtime deps; new `ml` group added
uv sync                  # install the locked deps (excludes the heavy `ml` group)
# Only when you want real FinBERT sentiment scoring (pulls torch, ~large):
uv sync --group ml
cd ../..
```

---

## 2. Credentials you need

**None are required to boot.** Every provider is optional — the code degrades to
a mock/no-op when a key is missing, so you can run the whole pipeline today and
add live data when you're ready. Supply them to exercise real venues.

| Env key | Used by | Required? | Where to get it |
|---|---|---|---|
| `OANDA_API_TOKEN` | QN-020 stream, QN-021 backfill, `seed:creds` | For live prices | OANDA **Practice** account → *the Hub* → **Manage API Access** → *Generate* |
| `OANDA_ACCOUNT_ID` | same | For live prices | OANDA account list (format `101-004-XXXXXXX-001`) |
| `OANDA_ENVIRONMENT` | selects host | Defaults to `practice` | `practice` (demo) or `live`. Keep `practice` for now |
| `TWELVE_DATA_API_KEY` | QN-021 backfill cross-check | Optional | Free tier at <https://twelvedata.com> (~8 req/min, 800/day) |
| `FRED_API_KEY` | BE-043 macro (rates, DXY, etc.) | Optional | <https://fredaccount.stlouisfed.org/apikeys> (free) |
| `EIA_API_KEY` | BE-043 macro (oil inventories) | Optional | <https://www.eia.gov/opendata/register.php> (free) |
| *(none)* | BE-043 COT positioning | — | CFTC data is public, no key |

**Getting the OANDA practice creds (recommended first):**
1. Create a free **fxTrade Practice** (demo) account at <https://www.oanda.com>.
2. In *the OANDA Hub* → **Manage API Access** → generate a personal access token → that's `OANDA_API_TOKEN`.
3. Your `OANDA_ACCOUNT_ID` is the demo account number shown in the account list.
4. Leave `OANDA_ENVIRONMENT=practice` (the code targets `*-fxpractice.oanda.com`).

Security: the token is a bearer credential — keep it in `.env` (git-ignored),
never commit it. Phase 5 moves creds into an encrypted settings store; until then
`pnpm seed:creds` seals them into the DB from these env vars.

---

## 3. Configure your `.env`

The keys above are already listed (commented) in `.env.example`. Copy the file if
you haven't, then uncomment/fill what you have:

```bash
cp .env.example .env      # if you don't already have one
```

```dotenv
# --- Step 1.6 market-data providers (all optional) ---
OANDA_API_TOKEN=your-practice-token
OANDA_ACCOUNT_ID=101-004-XXXXXXX-001
OANDA_ENVIRONMENT=practice
TWELVE_DATA_API_KEY=your-twelve-data-key
FRED_API_KEY=your-fred-key
EIA_API_KEY=your-eia-key
```

`REDIS_URL` is already required infra (defaults to `redis://localhost:6379`).
`pnpm check-env` verifies your `.env` has every required key.

---

## 4. Run it

### a. Bring up infrastructure (Postgres/TimescaleDB + Redis + services)

```bash
open -a Docker            # Docker Desktop must be running
pnpm stack:up            # build + start db, redis, quant, api, web, worker (detached)
pnpm stack:ps            # all should be "healthy"
```

The stack now includes the **BE-040 `worker`** service (aggregates ticks → M1).
The Node worker starts by default and idles until ticks arrive.

### b. Prepare the database (first time)

```bash
pnpm db:deploy            # apply migrations
pnpm db:timescale         # hypertables + CAGGs (M1→M5→…→D1) + retention
pnpm seed:dev             # dev fixtures (incl. sample EUR/USD candles)
# Once OANDA creds are in .env, seal them into the DB:
pnpm seed:creds
```

### c. Start the market-data worker (BE-040)

`pnpm stack:up` already runs it in Docker. To run it directly (hot-reload) while
coding instead:

```bash
pnpm --filter @fx/node-api worker:market-data
```

### c2. Run the ingestion runners (QN-020 / QN-021 / QN-022)

These are now wired as CLI entrypoints. Each **no-ops with a clear log line** if
its creds/config are missing, so they're safe to run in mock mode.

```bash
cd services/quant

# QN-020 — stream OANDA prices → the `market-ticks` queue (Node worker consumes).
uv run python -m app.market stream        # needs OANDA_* + REDIS_URL

# QN-021 — backfill the last 6 months of candles → TimescaleDB (+ cross-check).
uv run python -m app.market backfill      # needs OANDA_* + DATABASE_URL (+ TWELVE_DATA_API_KEY)

# QN-022 — score unscored news with FinBERT and store sentiment.
uv run python -m app.market sentiment     # needs DATABASE_URL + `uv sync --group ml`
```

Or in Docker — the stream has an opt-in `ingest` profile (needs OANDA creds in
your env):

```bash
docker compose -f infra/docker-compose.local.yml --profile ingest up -d quant-stream
# one-off backfill/sentiment inside the quant container:
docker compose -f infra/docker-compose.local.yml run --rm quant python -m app.market backfill
```

Full local loop with live data: `stream` (producer) + the `worker` (consumer,
already up) → M1 candles land in TimescaleDB → `GET /market/candles` serves them.

### d. Query the data (BE-045 REST — works as soon as candles exist)

```bash
# All requests need the internal token header (Phase-1 auth stand-in):
TOKEN=$(grep INTERNAL_API_TOKEN .env | cut -d= -f2)

curl -H "x-internal-token: $TOKEN" localhost:4000/market/instruments
curl -H "x-internal-token: $TOKEN" \
  "localhost:4000/market/candles?instrument=EUR_USD&timeframe=H1&limit=100"
curl -H "x-internal-token: $TOKEN" \
  "localhost:4000/market/news?instrument=EUR_USD&asOf=2026-03-10T12:00:00Z"
```

### e. What runs today

Everything is wired end to end — no missing entrypoints:

| Piece | How to run |
|---|---|
| BE-040 worker | `worker` service in `pnpm stack:up`, or `pnpm --filter @fx/node-api worker:market-data` |
| BE-042/044/045 REST + monitor | `api` service — the `/market/*` endpoints above |
| QN-020 OANDA stream | `uv run python -m app.market stream` (or `--profile ingest`) |
| QN-021 backfill + cross-check | `uv run python -m app.market backfill` |
| QN-022 FinBERT sentiment | `uv run python -m app.market sentiment` (`uv sync --group ml`) |

The stream publishes ticks to `market-ticks`; the worker consumes them and
writes M1 candles that `GET /market/candles` then serves.

---

## 5. Verify (what CI will check)

```bash
pnpm --filter @fx/node-api typecheck     # should be clean now that bullmq/ioredis are installed
pnpm --filter @fx/node-api test          # vitest — market modules, routes, worker processor
pnpm --filter @fx/node-api lint

cd services/quant
uv run pytest                            # QN-020/021/022 tests (needs Python 3.13 via uv)
uv run ruff check . && uv run mypy       # lint + strict types
cd ../..
```

Already verified by the assistant (sandbox limits aside): full `tsc --noEmit`
clean across `node-api` + `@fx/types`; every new Python file compiles; and 9
acceptance-critical pure-logic assertions ran green (candle rollover/gap,
data-quality gap+stale, COT release-time, news dedupe, H1 signal enqueue).

---

## 6. Gotchas & notes

- **FinBERT is heavy.** The `ml` group (`transformers` + `torch`) is excluded
  from the default `uv sync` on purpose. Install it only when scoring sentiment
  for real, and the first run downloads the `ProsusAI/finbert` model.
- **Twelve Data free tier** is rate-limited — the backfill only *samples* bars
  for cross-check (default every 200th). Energy CFDs (WTI/Brent) have no reliable
  Twelve Data symbol, so their cross-check is skipped by design.
- **No new DB migration** — Step 1.6 writes to tables that already existed from
  Step 1.4 (`candles`, `ticks`, `news_archive`, `macro_features`, …).
- **Prisma engine** downloads from `binaries.prisma.sh` on first `db:*` — make
  sure that's reachable from your machine (it was blocked in the sandbox).
- **No-look-ahead is enforced at read time:** news via `published_at <= asOf`,
  macro via `release_ts` (COT joins on the Friday *release*, not the Tuesday
  reference). Keep that invariant when you extend these.
- **Design note:** the market modules and worker live inside `@fx/node-api`
  (`src/market/*`, `src/workers/*`) rather than a separate `workers/*` package —
  revisit if a second worker is added.

---

## 7. Then what?

Next planned step is **1.7 — Design system** (FE-010 Tailwind v4 + shadcn in
`packages/ui`, FE-011 trading compositions). The cross-cutting observability /
backup epics (BE-140…142) are still open from Phase 1.
