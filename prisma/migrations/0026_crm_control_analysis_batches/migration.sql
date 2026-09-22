CREATE TABLE "CrmControlAnalysisBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "scopeRole" TEXT NOT NULL,
  "managerId" TEXT,
  "groupId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "activeKey" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "cursor" TEXT,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "queued" INTEGER NOT NULL DEFAULT 0,
  "deferred" INTEGER NOT NULL DEFAULT 0,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "CrmControlAnalysisBatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CrmControlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CrmControlAnalysisBatch_requestKey_key" ON "CrmControlAnalysisBatch"("requestKey");
CREATE UNIQUE INDEX "CrmControlAnalysisBatch_activeKey_key" ON "CrmControlAnalysisBatch"("activeKey");
CREATE INDEX "CrmControlAnalysisBatch_status_createdAt_idx" ON "CrmControlAnalysisBatch"("status", "createdAt");
