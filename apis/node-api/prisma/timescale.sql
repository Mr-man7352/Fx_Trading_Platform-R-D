-- BE-020 — TimescaleDB layer: hypertables, continuous aggregates, compression,
-- retention. Applied AFTER `prisma migrate deploy` by `pnpm db:timescale`
-- (scripts/apply-timescale.ts), one statement at a time OUTSIDE a transaction —
-- CAGG creation cannot run inside one, and Prisma wraps every migration in one.
--
-- Every statement is idempotent (IF NOT EXISTS / if_not_exists => true), so the
-- script is safe to re-run on every deploy.
--
-- RULE for this file: one statement per `;` at end of line, NO dollar-quoted
-- bodies (the applier splits naively). Functions/triggers belong in Prisma
-- migrations instead.

-- ── Hypertables (§7.1) ───────────────────────────────────────────────────────
-- Chunk sizing: ticks are high-volume (1 day); bar-level tables 1 week;
-- news/macro are sparse (1 month).

SELECT create_hypertable('candles', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('ticks', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('spreads_hist', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('news_archive', by_range('published_at', INTERVAL '1 month'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('macro_features', by_range('release_ts', INTERVAL '1 month'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('features', by_range('bar_ts', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE);

-- ── pgvector ANN index (BE-021) ──────────────────────────────────────────────
-- Lives here (not in the migration) so the CI drift check — which runs before
-- this script — never sees an index Prisma's schema can't express.

CREATE INDEX IF NOT EXISTS agent_memory_embedding_hnsw_idx ON agent_memory USING hnsw (embedding vector_cosine_ops);

-- ── Continuous aggregates: M1 base → M5 → M15 → H1 → H4 → D1 (hierarchical) ─
-- Buckets are UTC-aligned; D1 therefore closes at 00:00 UTC (not 17:00 New
-- York). Revisit with a timezone-aware bucket if daily strategy logic needs
-- the FX-convention close.

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_m5
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '5 minutes', ts) AS bucket,
  instrument,
  first(open, ts) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, ts) AS close,
  sum(volume) AS volume
FROM candles
WHERE timeframe = 'M1'
GROUP BY bucket, instrument
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_m15
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '15 minutes', bucket) AS bucket,
  instrument,
  first(open, bucket) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, bucket) AS close,
  sum(volume) AS volume
FROM candles_m5
GROUP BY 1, instrument
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_h1
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  instrument,
  first(open, bucket) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, bucket) AS close,
  sum(volume) AS volume
FROM candles_m15
GROUP BY 1, instrument
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_h4
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '4 hours', bucket) AS bucket,
  instrument,
  first(open, bucket) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, bucket) AS close,
  sum(volume) AS volume
FROM candles_h1
GROUP BY 1, instrument
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_d1
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', bucket) AS bucket,
  instrument,
  first(open, bucket) AS open,
  max(high) AS high,
  min(low) AS low,
  last(close, bucket) AS close,
  sum(volume) AS volume
FROM candles_h4
GROUP BY 1, instrument
WITH NO DATA;

-- ── Refresh policies ─────────────────────────────────────────────────────────
-- end_offset stays ≥ 1 bucket behind now() so only complete buckets
-- materialize; live edges are read from the base table by the API.

SELECT add_continuous_aggregate_policy('candles_m5', start_offset => INTERVAL '1 hour', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('candles_m15', start_offset => INTERVAL '3 hours', end_offset => INTERVAL '15 minutes', schedule_interval => INTERVAL '15 minutes', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('candles_h1', start_offset => INTERVAL '12 hours', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('candles_h4', start_offset => INTERVAL '2 days', end_offset => INTERVAL '4 hours', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('candles_d1', start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '6 hours', if_not_exists => TRUE);

-- ── Compression (columnstore) ────────────────────────────────────────────────

ALTER TABLE candles SET (timescaledb.compress, timescaledb.compress_segmentby = 'instrument, timeframe', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('candles', compress_after => INTERVAL '30 days', if_not_exists => TRUE);

ALTER TABLE ticks SET (timescaledb.compress, timescaledb.compress_segmentby = 'instrument', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('ticks', compress_after => INTERVAL '7 days', if_not_exists => TRUE);

ALTER TABLE spreads_hist SET (timescaledb.compress, timescaledb.compress_segmentby = 'instrument', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('spreads_hist', compress_after => INTERVAL '30 days', if_not_exists => TRUE);

ALTER TABLE features SET (timescaledb.compress, timescaledb.compress_segmentby = 'instrument, timeframe', timescaledb.compress_orderby = 'bar_ts');
SELECT add_compression_policy('features', compress_after => INTERVAL '30 days', if_not_exists => TRUE);

-- ── Retention ────────────────────────────────────────────────────────────────
-- candles/features/news/macro are kept forever (backtest history).

SELECT add_retention_policy('ticks', drop_after => INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('spreads_hist', drop_after => INTERVAL '180 days', if_not_exists => TRUE);
