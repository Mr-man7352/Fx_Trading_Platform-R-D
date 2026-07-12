-- CreateTable
CREATE TABLE "kill_switch_state" (
    "id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "activated_by" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_by" TEXT,
    "deactivated_at" TIMESTAMPTZ(6),
    "close_out_status" TEXT,
    "close_report" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kill_switch_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kill_switch_state_activated_at_idx" ON "kill_switch_state"("activated_at");
