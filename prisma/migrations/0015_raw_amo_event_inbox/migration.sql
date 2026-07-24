CREATE TABLE "raw_amo_event_inbox" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "webhookEventId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "externalId" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'received',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "amoUpdatedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "raw_amo_event_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "raw_amo_event_inbox_webhookEventId_key" ON "raw_amo_event_inbox"("webhookEventId");
CREATE UNIQUE INDEX "raw_amo_event_inbox_dedupeKey_key" ON "raw_amo_event_inbox"("dedupeKey");
CREATE INDEX "raw_amo_event_inbox_connectionId_status_receivedAt_idx" ON "raw_amo_event_inbox"("connectionId", "status", "receivedAt");
CREATE INDEX "raw_amo_event_inbox_connectionId_status_nextAttemptAt_idx" ON "raw_amo_event_inbox"("connectionId", "status", "nextAttemptAt");
CREATE INDEX "raw_amo_event_inbox_connectionId_appliedAt_idx" ON "raw_amo_event_inbox"("connectionId", "appliedAt");
CREATE INDEX "raw_amo_event_inbox_entity_externalId_idx" ON "raw_amo_event_inbox"("entity", "externalId");

ALTER TABLE "raw_amo_event_inbox"
  ADD CONSTRAINT "raw_amo_event_inbox_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AmoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "raw_amo_event_inbox" (
  "id",
  "connectionId",
  "webhookEventId",
  "dedupeKey",
  "entity",
  "action",
  "externalId",
  "payload",
  "status",
  "attempts",
  "error",
  "receivedAt",
  "processedAt",
  "appliedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  we."id",
  we."connectionId",
  we."id",
  md5(concat_ws('|', we."connectionId", we."entity", we."action", coalesce(we."externalId", ''), we."payload"::text)),
  we."entity",
  we."action",
  we."externalId",
  we."payload",
  CASE WHEN we."processedAt" IS NULL THEN we."status" ELSE 'applied' END,
  CASE WHEN we."processedAt" IS NULL THEN 0 ELSE 1 END,
  we."error",
  we."receivedAt",
  we."processedAt",
  we."processedAt",
  we."receivedAt",
  coalesce(we."processedAt", we."receivedAt")
FROM "WebhookEvent" AS we
WHERE we."processedAt" IS NULL OR we."receivedAt" >= now() - interval '1 day'
ON CONFLICT ("dedupeKey") DO NOTHING;
