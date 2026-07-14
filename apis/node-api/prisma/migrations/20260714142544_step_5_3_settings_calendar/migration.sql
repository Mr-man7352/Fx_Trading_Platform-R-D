-- CreateTable
CREATE TABLE "platform_settings" (
    "version" SERIAL NOT NULL,
    "settings" JSONB NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "currency" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'forexfactory',
    "forecast" TEXT,
    "previous" TEXT,
    "actual" TEXT,
    "raw" JSONB,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_events_ts_idx" ON "calendar_events"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_source_ts_currency_title_key" ON "calendar_events"("source", "ts", "currency", "title");
