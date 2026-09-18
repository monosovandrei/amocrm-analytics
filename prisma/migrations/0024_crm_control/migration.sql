-- CreateTable
CREATE TABLE "CrmControlSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmControlSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmControlRun" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "trigger" TEXT NOT NULL,
    "requestedBy" TEXT,
    "sourceRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sourceSyncAt" TIMESTAMP(3),
    "config" JSONB NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "ruleVersion" TEXT NOT NULL DEFAULT '1',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmControlRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmControlObservation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "dealExternalId" TEXT NOT NULL,
    "dealTitle" TEXT NOT NULL,
    "dealUrl" TEXT NOT NULL,
    "managerId" TEXT,
    "managerName" TEXT,
    "groupId" TEXT,
    "groupName" TEXT,
    "department" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "pipelineName" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "counts" JSONB NOT NULL,

    CONSTRAINT "CrmControlObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmControlResult" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "clauses" JSONB NOT NULL DEFAULT '[]',
    "details" JSONB NOT NULL DEFAULT '{}',
    "caseId" TEXT,

    CONSTRAINT "CrmControlResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmControlCase" (
    "id" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "dealId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "firstDetectedAt" TIMESTAMP(3) NOT NULL,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "exemptionUntil" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "assessmentHash" TEXT NOT NULL,
    "latestObservationId" TEXT NOT NULL,

    CONSTRAINT "CrmControlCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmControlDecision" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "managerId" TEXT,
    "groupId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmControlDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmControlEvidence" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceUrl" TEXT NOT NULL,
    "storageKey" TEXT,
    "contentType" TEXT,
    "sha256" TEXT,
    "capturedAt" TIMESTAMP(3),
    "coverage" TEXT,
    "startedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmControlEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlRun_requestKey_key" ON "CrmControlRun"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlRun_activeKey_key" ON "CrmControlRun"("activeKey");

-- CreateIndex
CREATE INDEX "CrmControlRun_status_createdAt_idx" ON "CrmControlRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CrmControlRun_scheduledFor_idx" ON "CrmControlRun"("scheduledFor");

-- CreateIndex
CREATE INDEX "CrmControlObservation_runId_managerId_id_idx" ON "CrmControlObservation"("runId", "managerId", "id");

-- CreateIndex
CREATE INDEX "CrmControlObservation_runId_groupId_id_idx" ON "CrmControlObservation"("runId", "groupId", "id");

-- CreateIndex
CREATE INDEX "CrmControlObservation_dealId_observedAt_idx" ON "CrmControlObservation"("dealId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlObservation_runId_dealId_key" ON "CrmControlObservation"("runId", "dealId");

-- CreateIndex
CREATE INDEX "CrmControlResult_caseId_idx" ON "CrmControlResult"("caseId");

-- CreateIndex
CREATE INDEX "CrmControlResult_status_observationId_idx" ON "CrmControlResult"("status", "observationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlResult_observationId_ruleCode_subjectId_key" ON "CrmControlResult"("observationId", "ruleCode", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlCase_caseKey_key" ON "CrmControlCase"("caseKey");

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlCase_activeKey_key" ON "CrmControlCase"("activeKey");

-- CreateIndex
CREATE INDEX "CrmControlCase_dealId_status_idx" ON "CrmControlCase"("dealId", "status");

-- CreateIndex
CREATE INDEX "CrmControlDecision_caseId_createdAt_idx" ON "CrmControlDecision"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmControlEvidence_observationId_key" ON "CrmControlEvidence"("observationId");

-- CreateIndex
CREATE INDEX "CrmControlEvidence_status_createdAt_idx" ON "CrmControlEvidence"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CrmControlEvidence_status_nextAttemptAt_createdAt_idx" ON "CrmControlEvidence"("status", "nextAttemptAt", "createdAt");

-- AddForeignKey
ALTER TABLE "CrmControlObservation" ADD CONSTRAINT "CrmControlObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CrmControlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmControlResult" ADD CONSTRAINT "CrmControlResult_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "CrmControlObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmControlResult" ADD CONSTRAINT "CrmControlResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CrmControlCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmControlDecision" ADD CONSTRAINT "CrmControlDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CrmControlCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmControlEvidence" ADD CONSTRAINT "CrmControlEvidence_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "CrmControlObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
