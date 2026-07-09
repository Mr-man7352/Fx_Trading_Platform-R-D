-- CreateTable
CREATE TABLE "model_registry" (
    "id" UUID NOT NULL,
    "instrument" TEXT NOT NULL,
    "timeframe" "timeframe" NOT NULL,
    "version" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'challenger',
    "calibration_method" TEXT NOT NULL,
    "feature_set_version" INTEGER NOT NULL,
    "trained_at" TIMESTAMPTZ(6) NOT NULL,
    "metrics" JSONB,
    "artifact_path" TEXT NOT NULL,
    "shadow_count" INTEGER NOT NULL DEFAULT 0,
    "last_shadow_at" TIMESTAMPTZ(6),
    "promoted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correlation_clusters" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "trigger" TEXT NOT NULL,
    "lookback_days" INTEGER NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "clusters" JSONB NOT NULL,
    "params" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correlation_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_registry_instrument_timeframe_role_idx" ON "model_registry"("instrument", "timeframe", "role");

-- CreateIndex
CREATE UNIQUE INDEX "model_registry_instrument_timeframe_version_key" ON "model_registry"("instrument", "timeframe", "version");

-- CreateIndex
CREATE UNIQUE INDEX "correlation_clusters_version_key" ON "correlation_clusters"("version");

-- CreateIndex
CREATE INDEX "correlation_clusters_computed_at_idx" ON "correlation_clusters"("computed_at");
