ALTER TABLE "Deal"
ADD COLUMN "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DealStageHistory"
ADD COLUMN "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Deal_syncedAt_idx" ON "Deal"("syncedAt");
CREATE INDEX "DealStageHistory_ingestedAt_idx" ON "DealStageHistory"("ingestedAt");
