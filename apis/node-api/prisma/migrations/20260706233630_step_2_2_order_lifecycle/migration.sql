-- AlterEnum
ALTER TYPE "intent_status" ADD VALUE 'executed';

-- AlterTable
ALTER TABLE "trade_intents" ADD COLUMN     "reason_code" TEXT;
