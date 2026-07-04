-- Step 1.4 init migration (BE-020…023, BE-130, BE-131).
-- Hand-authored to match schema.prisma exactly (Prisma naming conventions);
-- CI's drift check (`prisma migrate diff --from-url … --exit-code`) verifies
-- the match on every PR. TimescaleDB objects (hypertables/CAGGs/policies) and
-- the pgvector HNSW index are NOT here — see prisma/timescale.sql (BE-020).

-- Extensions (also enabled by infra/db/init for fresh compose volumes).
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "trading_mode" AS ENUM ('backtest', 'paper', 'live');

-- CreateEnum
CREATE TYPE "trade_side" AS ENUM ('long', 'short');

-- CreateEnum
CREATE TYPE "timeframe" AS ENUM ('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1');

-- CreateEnum
CREATE TYPE "signal_status" AS ENUM ('candidate', 'approved', 'rejected', 'expired', 'executed');

-- CreateEnum
CREATE TYPE "debate_speaker" AS ENUM ('bull', 'bear', 'judge');

-- CreateEnum
CREATE TYPE "intent_status" AS ENUM ('pending', 'approved', 'rejected', 'submitted', 'cancelled');

-- CreateEnum
CREATE TYPE "trade_status" AS ENUM ('open', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "supervision_action" AS ENUM ('hold', 'close', 'tighten_stop', 'take_partial');

-- CreateEnum
CREATE TYPE "backtest_status" AS ENUM ('queued', 'running', 'finished', 'failed');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "token_purpose" AS ENUM ('verify_email', 'password_reset');

-- CreateEnum
CREATE TYPE "broker" AS ENUM ('oanda', 'mt5');

-- CreateEnum
CREATE TYPE "broker_environment" AS ENUM ('practice', 'live');

-- CreateTable
CREATE TABLE "candles" (
    "instrument" TEXT NOT NULL,
    "timeframe" "timeframe" NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'oanda',

    CONSTRAINT "candles_pkey" PRIMARY KEY ("instrument","timeframe","ts")
);

-- CreateTable
CREATE TABLE "ticks" (
    "instrument" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "bid" DOUBLE PRECISION NOT NULL,
    "ask" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ticks_pkey" PRIMARY KEY ("instrument","ts")
);

-- CreateTable
CREATE TABLE "spreads_hist" (
    "instrument" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "spread_pips" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "spreads_hist_pkey" PRIMARY KEY ("instrument","ts")
);

-- CreateTable
CREATE TABLE "news_archive" (
    "id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT,
    "headline" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT,
    "instruments" TEXT[],
    "sentiment" DOUBLE PRECISION,
    "raw" JSONB,

    CONSTRAINT "news_archive_pkey" PRIMARY KEY ("published_at","id")
);

-- CreateTable
CREATE TABLE "macro_features" (
    "series" TEXT NOT NULL,
    "release_ts" TIMESTAMPTZ(6) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "period" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "macro_features_pkey" PRIMARY KEY ("series","release_ts","revision")
);

-- CreateTable
CREATE TABLE "features" (
    "instrument" TEXT NOT NULL,
    "timeframe" "timeframe" NOT NULL,
    "bar_ts" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "session_label" TEXT,
    "liquidity_regime" TEXT,
    "features" JSONB NOT NULL,

    CONSTRAINT "features_pkey" PRIMARY KEY ("instrument","timeframe","bar_ts","version")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bar_ts" TIMESTAMPTZ(6) NOT NULL,
    "instrument" TEXT NOT NULL,
    "timeframe" "timeframe" NOT NULL,
    "side" "trade_side" NOT NULL,
    "entry_price" DECIMAL(14,6),
    "stop_loss" DECIMAL(14,6),
    "take_profit" DECIMAL(14,6),
    "quant_score" DOUBLE PRECISION,
    "meta_probability" DOUBLE PRECISION,
    "status" "signal_status" NOT NULL DEFAULT 'candidate',
    "trading_mode" "trading_mode" NOT NULL,
    "features" JSONB,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "signal_id" UUID,
    "agent_role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "output" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_debates" (
    "id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "speaker" "debate_speaker" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_debates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory" (
    "id" UUID NOT NULL,
    "bar_ts" TIMESTAMPTZ(6) NOT NULL,
    "instrument" TEXT NOT NULL,
    "agent_role" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "embedding" vector(1536),
    "outcome" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_intents" (
    "id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "instrument" TEXT NOT NULL,
    "side" "trade_side" NOT NULL,
    "units" DECIMAL(16,2) NOT NULL,
    "entry_price" DECIMAL(14,6),
    "stop_loss" DECIMAL(14,6) NOT NULL,
    "take_profit" DECIMAL(14,6),
    "risk_pct" DOUBLE PRECISION NOT NULL,
    "risk_gate" JSONB NOT NULL,
    "status" "intent_status" NOT NULL DEFAULT 'pending',
    "trading_mode" "trading_mode" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "trade_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "intent_id" UUID,
    "user_id" UUID,
    "instrument" TEXT NOT NULL,
    "side" "trade_side" NOT NULL,
    "units" DECIMAL(16,2) NOT NULL,
    "entry_price" DECIMAL(14,6) NOT NULL,
    "exit_price" DECIMAL(14,6),
    "stop_loss" DECIMAL(14,6),
    "take_profit" DECIMAL(14,6),
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "broker_trade_id" TEXT,
    "broker_order_id" TEXT,
    "realized_pnl" DECIMAL(14,6),
    "swap_pnl" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "commission" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "status" "trade_status" NOT NULL DEFAULT 'open',
    "trading_mode" "trading_mode" NOT NULL,
    "meta" JSONB,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisions" (
    "id" UUID NOT NULL,
    "trade_id" UUID NOT NULL,
    "agent_run_id" UUID,
    "action" "supervision_action" NOT NULL,
    "rationale" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_signals" (
    "id" UUID NOT NULL,
    "bar_ts" TIMESTAMPTZ(6) NOT NULL,
    "instrument" TEXT NOT NULL,
    "timeframe" "timeframe" NOT NULL,
    "side" "trade_side",
    "quant_score" DOUBLE PRECISION NOT NULL,
    "would_trade" BOOLEAN NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "role" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "trading_mode" "trading_mode" NOT NULL,
    "details" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "status" "backtest_status" NOT NULL DEFAULT 'queued',
    "config" JSONB NOT NULL,
    "metrics" JSONB,
    "validation_verdict" TEXT,
    "git_commit" TEXT,
    "artifact_path" TEXT,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "google_id" TEXT,
    "password_hash" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'operator',
    "status" "user_status" NOT NULL DEFAULT 'active',
    "email_verified_at" TIMESTAMPTZ(6),
    "totp_secret" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_by_id" UUID,
    "invited_email" TEXT,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" "token_purpose" NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "broker" "broker" NOT NULL DEFAULT 'oanda',
    "environment" "broker_environment" NOT NULL DEFAULT 'practice',
    "label" TEXT NOT NULL DEFAULT 'default',
    "ciphertext" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "broker_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candles_ts_idx" ON "candles"("ts");

-- CreateIndex
CREATE INDEX "news_archive_source_published_at_idx" ON "news_archive"("source", "published_at");

-- CreateIndex
CREATE INDEX "features_bar_ts_idx" ON "features"("bar_ts");

-- CreateIndex
CREATE INDEX "signals_instrument_bar_ts_idx" ON "signals"("instrument", "bar_ts");

-- CreateIndex
CREATE INDEX "signals_status_created_at_idx" ON "signals"("status", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_signal_id_idx" ON "agent_runs"("signal_id");

-- CreateIndex
CREATE INDEX "agent_runs_agent_role_created_at_idx" ON "agent_runs"("agent_role", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_debates_signal_id_seq_key" ON "agent_debates"("signal_id", "seq");

-- CreateIndex
CREATE INDEX "agent_debates_signal_id_round_idx" ON "agent_debates"("signal_id", "round");

-- CreateIndex
CREATE INDEX "agent_memory_bar_ts_idx" ON "agent_memory"("bar_ts");

-- CreateIndex
CREATE INDEX "agent_memory_instrument_agent_role_bar_ts_idx" ON "agent_memory"("instrument", "agent_role", "bar_ts");

-- CreateIndex
CREATE INDEX "trade_intents_status_created_at_idx" ON "trade_intents"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "trades_intent_id_key" ON "trades"("intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_broker_trade_id_key" ON "trades"("broker_trade_id");

-- CreateIndex
CREATE INDEX "trades_status_idx" ON "trades"("status");

-- CreateIndex
CREATE INDEX "trades_instrument_opened_at_idx" ON "trades"("instrument", "opened_at");

-- CreateIndex
CREATE INDEX "supervisions_trade_id_created_at_idx" ON "supervisions"("trade_id", "created_at");

-- CreateIndex
CREATE INDEX "baseline_signals_instrument_bar_ts_idx" ON "baseline_signals"("instrument", "bar_ts");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "audit_log"("actor_id", "at");

-- CreateIndex
CREATE INDEX "backtest_runs_status_created_at_idx" ON "backtest_runs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_codes_code_key" ON "invite_codes"("code");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "broker_credentials_user_id_broker_environment_label_key" ON "broker_credentials"("user_id", "broker", "environment", "label");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_debates" ADD CONSTRAINT "agent_debates_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "trade_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisions" ADD CONSTRAINT "supervisions_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_credentials" ADD CONSTRAINT "broker_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BE-130 — audit_log is append-only: block UPDATE/DELETE (row) and TRUNCATE
-- (statement) at the database level. Triggers are not introspected by Prisma,
-- so this does not trip the CI drift check.
CREATE FUNCTION fx_audit_log_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (BE-130): % blocked', TG_OP;
END;
$$;

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION fx_audit_log_block_mutation();

CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION fx_audit_log_block_mutation();
