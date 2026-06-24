ALTER TABLE "NotificationTemplate"
  ADD COLUMN "recipients" JSONB NOT NULL DEFAULT '[]';
