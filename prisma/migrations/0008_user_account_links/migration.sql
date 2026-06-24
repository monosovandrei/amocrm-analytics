CREATE TYPE "PlatformBusinessRole" AS ENUM ('OWNER', 'ROP', 'MANAGER');

ALTER TABLE "User"
  ADD COLUMN "businessRole" "PlatformBusinessRole" NOT NULL DEFAULT 'MANAGER',
  ADD COLUMN "crmUserId" TEXT;

UPDATE "User" SET "businessRole" = 'OWNER' WHERE "role" = 'ADMIN';
UPDATE "User" SET "businessRole" = 'ROP' WHERE "role" = 'ROP';

CREATE UNIQUE INDEX "User_crmUserId_key" ON "User"("crmUserId");
CREATE INDEX "User_businessRole_isActive_idx" ON "User"("businessRole", "isActive");

ALTER TABLE "User"
  ADD CONSTRAINT "User_crmUserId_fkey"
  FOREIGN KEY ("crmUserId") REFERENCES "CrmUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
