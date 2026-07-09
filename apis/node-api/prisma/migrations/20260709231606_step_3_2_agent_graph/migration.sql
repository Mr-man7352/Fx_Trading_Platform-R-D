-- AlterTable
ALTER TABLE "agent_memory" ADD COLUMN     "embedding_model" TEXT NOT NULL DEFAULT 'fake-embedding-v1',
ADD COLUMN     "retrieval_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "signal_id" UUID;

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "retrieved_memory_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "disagreement_cohort" (
    "id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "quant_probability" DOUBLE PRECISION NOT NULL,
    "pm_decision" TEXT NOT NULL,
    "pm_rationale" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disagreement_cohort_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "disagreement_cohort_kind_created_at_idx" ON "disagreement_cohort"("kind", "created_at");

-- CreateIndex
CREATE INDEX "disagreement_cohort_signal_id_idx" ON "disagreement_cohort"("signal_id");

-- CreateIndex
CREATE INDEX "agent_memory_signal_id_idx" ON "agent_memory"("signal_id");

-- AddForeignKey
ALTER TABLE "disagreement_cohort" ADD CONSTRAINT "disagreement_cohort_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
