CREATE TABLE "CrmControlAnalysisJob" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelSha256" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "activeKey" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "attemptLimit" INTEGER NOT NULL DEFAULT 3,
    "errorCode" TEXT,
    "assessmentStatus" TEXT,
    "assessmentMessage" TEXT,
    "policyVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrmControlAnalysisJob_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CrmControlAnalysisAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "rawResponse" JSONB,
    "validation" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CrmControlAnalysisAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CrmControlAnalysisJob_activeKey_key" ON "CrmControlAnalysisJob"("activeKey");
CREATE UNIQUE INDEX "CrmControlAnalysisJob_resultId_inputHash_analyzerVersion_key" ON "CrmControlAnalysisJob"("resultId", "inputHash", "analyzerVersion");
CREATE INDEX "CrmControlAnalysisJob_status_nextAttemptAt_createdAt_idx" ON "CrmControlAnalysisJob"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "CrmControlAnalysisJob_status_leaseUntil_idx" ON "CrmControlAnalysisJob"("status", "leaseUntil");
CREATE UNIQUE INDEX "CrmControlAnalysisAttempt_jobId_attemptNo_key" ON "CrmControlAnalysisAttempt"("jobId", "attemptNo");
CREATE INDEX "CrmControlAnalysisAttempt_jobId_finishedAt_idx" ON "CrmControlAnalysisAttempt"("jobId", "finishedAt");
ALTER TABLE "CrmControlAnalysisJob" ADD CONSTRAINT "CrmControlAnalysisJob_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "CrmControlResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CrmControlAnalysisAttempt" ADD CONSTRAINT "CrmControlAnalysisAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrmControlAnalysisJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "CrmControlAnalysisRetryGrant" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "attemptLimit" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrmControlAnalysisRetryGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CrmControlAnalysisRetryGrant_jobId_requestKey_key" ON "CrmControlAnalysisRetryGrant"("jobId", "requestKey");
CREATE INDEX "CrmControlAnalysisRetryGrant_jobId_grantedAt_idx" ON "CrmControlAnalysisRetryGrant"("jobId", "grantedAt");
ALTER TABLE "CrmControlAnalysisRetryGrant" ADD CONSTRAINT "CrmControlAnalysisRetryGrant_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrmControlAnalysisJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
