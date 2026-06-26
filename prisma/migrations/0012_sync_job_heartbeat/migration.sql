ALTER TABLE "SyncJob"
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "SyncJob"
SET "heartbeatAt" = COALESCE("startedAt", "createdAt")
WHERE "heartbeatAt" IS NULL;

CREATE INDEX "SyncJob_status_heartbeatAt_idx" ON "SyncJob"("status", "heartbeatAt");

CREATE INDEX "WebhookEvent_connectionId_status_processedAt_idx"
  ON "WebhookEvent"("connectionId", "status", "processedAt");
