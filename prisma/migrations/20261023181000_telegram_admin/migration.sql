ALTER TABLE "NotificationTemplate" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "enabledAt" TIMESTAMP(3);
ALTER TABLE "NotificationTemplate" ADD COLUMN "groupIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE TABLE "TelegramSettings" (
  "id" TEXT NOT NULL DEFAULT 'default', "enabled" BOOLEAN NOT NULL DEFAULT false,
  "resumedAt" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  "parameters" JSONB NOT NULL DEFAULT '{}', "quality" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramSettings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "TelegramSettings" ("id","enabled","updatedAt") VALUES ('default',false,CURRENT_TIMESTAMP);
-- Existing rules are retained for inspection, but must be explicitly configured again.
UPDATE "NotificationTemplate" SET "isActive"=false, recipients='[{"kind":"delivery_mode","id":"disabled"}]', "version"="version"+1;
UPDATE "ReportSchedule" SET enabled=false, "nextRunAt"=NULL WHERE format='telegram';
ALTER TABLE "ReportSchedule" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AlertRule" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
