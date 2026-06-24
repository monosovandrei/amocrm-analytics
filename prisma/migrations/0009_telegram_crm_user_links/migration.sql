ALTER TABLE "TelegramAccount"
  ADD COLUMN "crmUserId" TEXT,
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "TelegramLinkCode"
  ADD COLUMN "crmUserId" TEXT,
  ALTER COLUMN "userId" DROP NOT NULL;

CREATE UNIQUE INDEX "TelegramAccount_crmUserId_key" ON "TelegramAccount"("crmUserId");
CREATE INDEX "TelegramLinkCode_crmUserId_createdAt_idx" ON "TelegramLinkCode"("crmUserId", "createdAt");

ALTER TABLE "TelegramAccount"
  ADD CONSTRAINT "TelegramAccount_crmUserId_fkey"
  FOREIGN KEY ("crmUserId") REFERENCES "CrmUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramLinkCode"
  ADD CONSTRAINT "TelegramLinkCode_crmUserId_fkey"
  FOREIGN KEY ("crmUserId") REFERENCES "CrmUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
