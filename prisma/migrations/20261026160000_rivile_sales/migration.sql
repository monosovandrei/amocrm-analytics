CREATE TABLE "RivileManagerLink" (
 "code" TEXT PRIMARY KEY, "crmUserId" TEXT, "departmentKey" TEXT,
 "source" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RivileManagerLink_crmUserId_departmentKey_idx" ON "RivileManagerLink" ("crmUserId", "departmentKey");
CREATE TABLE "SalesTargetProfile" (
 "crmUserId" TEXT PRIMARY KEY, "marginTarget" DECIMAL(65,30) NOT NULL,
 "paidTarget" INTEGER NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "RivileSalesSnapshot" (
 "month" TEXT PRIMARY KEY, "documents" JSONB NOT NULL DEFAULT '[]',
 "cutoffAt" TIMESTAMP(3), "throughDate" TEXT, "needsRefresh" BOOLEAN NOT NULL DEFAULT false, "requestedAt" TIMESTAMP(3), "lastAttemptAt" TIMESTAMP(3),
 "lastError" TEXT, "leaseUntil" TIMESTAMP(3), "runId" TEXT,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
