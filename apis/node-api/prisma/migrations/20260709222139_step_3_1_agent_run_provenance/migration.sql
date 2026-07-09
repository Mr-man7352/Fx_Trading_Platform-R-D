-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "downgrade_reason" TEXT,
ADD COLUMN     "failed_over" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "model_downgraded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'anthropic',
ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'standard';

-- CreateIndex
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs"("created_at");
