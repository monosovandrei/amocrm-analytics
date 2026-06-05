-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ROP');

-- CreateEnum
CREATE TYPE "AmoConnectionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ERROR', 'SYNCING');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('FULL', 'INCREMENTAL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'ERROR');

-- CreateEnum
CREATE TYPE "CrmEntityType" AS ENUM ('LEAD', 'CONTACT', 'COMPANY', 'TASK', 'NOTE', 'EVENT');

-- CreateEnum
CREATE TYPE "ReportSourceType" AS ENUM ('EVENT', 'CURRENT');

-- CreateEnum
CREATE TYPE "ConversionDenominator" AS ENUM ('PREVIOUS', 'FIRST');

-- CreateEnum
CREATE TYPE "ProbabilityMode" AS ENUM ('MANUAL', 'AUTO', 'HYBRID');

-- CreateEnum
CREATE TYPE "ExportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ROP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmoConnection" (
    "id" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT,
    "credentials" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL,
    "status" "AmoConnectionStatus" NOT NULL DEFAULT 'INACTIVE',
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "lastFullSyncAt" TIMESTAMP(3),
    "lastIncrementalSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "type" "SyncJobType" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "externalId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmGroup" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CrmGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmUser" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "groupId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CrmUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isShippingPipeline" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "color" TEXT,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "isLost" BOOLEAN NOT NULL DEFAULT false,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "entityType" "CrmEntityType" NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enums" JSONB NOT NULL DEFAULT '[]',
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmCompany" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LossReason" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "LossReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "responsibleId" TEXT,
    "contactId" TEXT,
    "lossReasonId" TEXT,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "source" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "closedAt" TIMESTAMP(3),
    "expectedCloseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealStageHistory" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL,
    "movedById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'sync',
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "DealStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealResponsibleHistory" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'sync',
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "DealResponsibleHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "dealId" TEXT,
    "responsibleId" TEXT,
    "title" TEXT NOT NULL,
    "typeId" INTEGER,
    "typeName" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "dealId" TEXT,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmEvent" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "dealId" TEXT,
    "type" TEXT NOT NULL,
    "valueBefore" JSONB,
    "valueAfter" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CrmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealProduct" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "DealProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "sourceType" "ReportSourceType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardLayout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSettings" (
    "id" TEXT NOT NULL,
    "closingStageId" TEXT,
    "shippingPipelineId" TEXT,
    "shippingSuccessStageId" TEXT,
    "probabilityMode" "ProbabilityMode" NOT NULL DEFAULT 'HYBRID',
    "minSampleSize" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForecastSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageProbability" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "manualPercent" DECIMAL(65,30),
    "autoPercent" DECIMAL(65,30),
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageProbability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "status" "ExportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "reportConfig" JSONB NOT NULL DEFAULT '{}',
    "filePath" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AmoConnection_webhookSecret_key" ON "AmoConnection"("webhookSecret");

-- CreateIndex
CREATE INDEX "SyncJob_connectionId_createdAt_idx" ON "SyncJob"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncJob_status_createdAt_idx" ON "SyncJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_connectionId_receivedAt_idx" ON "WebhookEvent"("connectionId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_entity_action_idx" ON "WebhookEvent"("entity", "action");

-- CreateIndex
CREATE UNIQUE INDEX "CrmGroup_externalId_key" ON "CrmGroup"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmUser_externalId_key" ON "CrmUser"("externalId");

-- CreateIndex
CREATE INDEX "CrmUser_groupId_idx" ON "CrmUser"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_externalId_key" ON "Pipeline"("externalId");

-- CreateIndex
CREATE INDEX "PipelineStage_pipelineId_position_idx" ON "PipelineStage"("pipelineId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_pipelineId_externalId_key" ON "PipelineStage"("pipelineId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_entityType_externalId_key" ON "CustomFieldDefinition"("entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_externalId_key" ON "Contact"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmCompany_externalId_key" ON "CrmCompany"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "LossReason_pipelineId_externalId_key" ON "LossReason"("pipelineId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_externalId_key" ON "Deal"("externalId");

-- CreateIndex
CREATE INDEX "Deal_pipelineId_stageId_idx" ON "Deal"("pipelineId", "stageId");

-- CreateIndex
CREATE INDEX "Deal_responsibleId_idx" ON "Deal"("responsibleId");

-- CreateIndex
CREATE INDEX "Deal_closedAt_idx" ON "Deal"("closedAt");

-- CreateIndex
CREATE INDEX "Deal_updatedAt_idx" ON "Deal"("updatedAt");

-- CreateIndex
CREATE INDEX "DealStageHistory_dealId_movedAt_idx" ON "DealStageHistory"("dealId", "movedAt");

-- CreateIndex
CREATE INDEX "DealStageHistory_toStageId_movedAt_idx" ON "DealStageHistory"("toStageId", "movedAt");

-- CreateIndex
CREATE INDEX "DealResponsibleHistory_dealId_changedAt_idx" ON "DealResponsibleHistory"("dealId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_externalId_key" ON "Task"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Note_externalId_key" ON "Note"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEvent_externalId_key" ON "CrmEvent"("externalId");

-- CreateIndex
CREATE INDEX "CrmEvent_type_createdAt_idx" ON "CrmEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "DealProduct_dealId_idx" ON "DealProduct"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "StageProbability_stageId_key" ON "StageProbability"("stageId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AmoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AmoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmUser" ADD CONSTRAINT "CrmUser_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CrmGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LossReason" ADD CONSTRAINT "LossReason_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_responsibleId_fkey" FOREIGN KEY ("responsibleId") REFERENCES "CrmUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_lossReasonId_fkey" FOREIGN KEY ("lossReasonId") REFERENCES "LossReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageHistory" ADD CONSTRAINT "DealStageHistory_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageHistory" ADD CONSTRAINT "DealStageHistory_fromStageId_fkey" FOREIGN KEY ("fromStageId") REFERENCES "PipelineStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageHistory" ADD CONSTRAINT "DealStageHistory_toStageId_fkey" FOREIGN KEY ("toStageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_responsibleId_fkey" FOREIGN KEY ("responsibleId") REFERENCES "CrmUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealProduct" ADD CONSTRAINT "DealProduct_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportTemplate" ADD CONSTRAINT "ReportTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardLayout" ADD CONSTRAINT "DashboardLayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageProbability" ADD CONSTRAINT "StageProbability_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
