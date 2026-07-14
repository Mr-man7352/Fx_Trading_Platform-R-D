-- AlterTable
ALTER TABLE "users" ADD COLUMN     "erased_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "paper_validation_runs" (
    "id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "verdict" TEXT NOT NULL,
    "underpowered" BOOLEAN NOT NULL DEFAULT false,
    "downgraded_share" DOUBLE PRECISION NOT NULL,
    "effect_size_r" DOUBLE PRECISION NOT NULL,
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_validation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_reports" (
    "id" UUID NOT NULL,
    "paper_validation_id" UUID,
    "content_html" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "config_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gdpr_exports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "zip" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "downloaded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gdpr_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "paper_validation_runs_created_at_idx" ON "paper_validation_runs"("created_at");

-- CreateIndex
CREATE INDEX "risk_reports_created_at_idx" ON "risk_reports"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "gdpr_exports_token_key" ON "gdpr_exports"("token");

-- CreateIndex
CREATE INDEX "gdpr_exports_user_id_idx" ON "gdpr_exports"("user_id");
