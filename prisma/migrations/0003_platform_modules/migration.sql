-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('TELEGRAM');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'ERROR', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AlertOperator" AS ENUM ('GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ');

-- CreateEnum
CREATE TYPE "PlanPeriodType" AS ENUM ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PlanTargetType" AS ENUM ('COMPANY', 'GROUP', 'MANAGER');

-- CreateEnum
CREATE TYPE "QualitySeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReportScheduleFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON');

-- CreateTable
CREATE TABLE "TelegramAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLinkCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "reportTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metricKey" TEXT,
    "operator" "AlertOperator" NOT NULL DEFAULT 'GTE',
    "threshold" DECIMAL(65,30),
    "condition" JSONB NOT NULL DEFAULT '{}',
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "checkEveryMinutes" INTEGER NOT NULL DEFAULT 15,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastCheckedAt" TIMESTAMP(3),
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "alertRuleId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "value" DECIMAL(65,30),
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "telegramAccountId" TEXT,
    "alertEventId" TEXT,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'TELEGRAM',
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanSet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanItem" (
    "id" TEXT NOT NULL,
    "planSetId" TEXT NOT NULL,
    "periodType" "PlanPeriodType" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "targetType" "PlanTargetType" NOT NULL,
    "targetId" TEXT,
    "targetName" TEXT,
    "metricKey" TEXT NOT NULL,
    "metricName" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'number',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanImport" (
    "id" TEXT NOT NULL,
    "planSetId" TEXT,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsAccepted" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityRule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "severity" "QualitySeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualitySnapshot" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "managerId" TEXT,
    "managerName" TEXT,
    "groupId" TEXT,
    "groupName" TEXT,
    "score" DECIMAL(65,30),
    "violationsCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityViolation" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "managerId" TEXT,
    "managerName" TEXT,
    "groupId" TEXT,
    "groupName" TEXT,
    "dealId" TEXT,
    "taskId" TEXT,
    "severity" "QualitySeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "QualityViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "ReportScheduleFrequency" NOT NULL DEFAULT 'DAILY',
    "cron" TEXT,
    "timeOfDay" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "format" TEXT NOT NULL DEFAULT 'telegram',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeliveryLog" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "message" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_userId_key" ON "TelegramAccount"("userId");
CREATE UNIQUE INDEX "TelegramAccount_chatId_key" ON "TelegramAccount"("chatId");
CREATE UNIQUE INDEX "TelegramLinkCode_code_key" ON "TelegramLinkCode"("code");
CREATE UNIQUE INDEX "QualityRule_code_key" ON "QualityRule"("code");
CREATE INDEX "TelegramLinkCode_code_expiresAt_idx" ON "TelegramLinkCode"("code", "expiresAt");
CREATE INDEX "TelegramLinkCode_userId_createdAt_idx" ON "TelegramLinkCode"("userId", "createdAt");
CREATE INDEX "AlertRule_enabled_lastCheckedAt_idx" ON "AlertRule"("enabled", "lastCheckedAt");
CREATE INDEX "AlertRule_userId_idx" ON "AlertRule"("userId");
CREATE INDEX "AlertRule_reportTemplateId_idx" ON "AlertRule"("reportTemplateId");
CREATE INDEX "AlertEvent_alertRuleId_createdAt_idx" ON "AlertEvent"("alertRuleId", "createdAt");
CREATE INDEX "AlertEvent_status_createdAt_idx" ON "AlertEvent"("status", "createdAt");
CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");
CREATE INDEX "NotificationDelivery_telegramAccountId_idx" ON "NotificationDelivery"("telegramAccountId");
CREATE INDEX "PlanSet_isActive_year_idx" ON "PlanSet"("isActive", "year");
CREATE INDEX "PlanSet_createdById_idx" ON "PlanSet"("createdById");
CREATE INDEX "PlanItem_planSetId_periodStart_periodEnd_idx" ON "PlanItem"("planSetId", "periodStart", "periodEnd");
CREATE INDEX "PlanItem_targetType_targetId_idx" ON "PlanItem"("targetType", "targetId");
CREATE INDEX "PlanItem_metricKey_idx" ON "PlanItem"("metricKey");
CREATE INDEX "PlanImport_planSetId_createdAt_idx" ON "PlanImport"("planSetId", "createdAt");
CREATE INDEX "QualityRule_enabled_severity_idx" ON "QualityRule"("enabled", "severity");
CREATE INDEX "QualitySnapshot_ruleId_createdAt_idx" ON "QualitySnapshot"("ruleId", "createdAt");
CREATE INDEX "QualitySnapshot_managerId_createdAt_idx" ON "QualitySnapshot"("managerId", "createdAt");
CREATE INDEX "QualitySnapshot_groupId_createdAt_idx" ON "QualitySnapshot"("groupId", "createdAt");
CREATE INDEX "QualityViolation_ruleId_detectedAt_idx" ON "QualityViolation"("ruleId", "detectedAt");
CREATE INDEX "QualityViolation_managerId_detectedAt_idx" ON "QualityViolation"("managerId", "detectedAt");
CREATE INDEX "QualityViolation_resolvedAt_idx" ON "QualityViolation"("resolvedAt");
CREATE INDEX "ReportSchedule_enabled_nextRunAt_idx" ON "ReportSchedule"("enabled", "nextRunAt");
CREATE INDEX "ReportSchedule_userId_idx" ON "ReportSchedule"("userId");
CREATE INDEX "ReportSchedule_reportTemplateId_idx" ON "ReportSchedule"("reportTemplateId");
CREATE INDEX "ReportDeliveryLog_scheduleId_createdAt_idx" ON "ReportDeliveryLog"("scheduleId", "createdAt");
CREATE INDEX "ReportDeliveryLog_status_createdAt_idx" ON "ReportDeliveryLog"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TelegramAccount" ADD CONSTRAINT "TelegramAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_reportTemplateId_fkey" FOREIGN KEY ("reportTemplateId") REFERENCES "ReportTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_alertRuleId_fkey" FOREIGN KEY ("alertRuleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_telegramAccountId_fkey" FOREIGN KEY ("telegramAccountId") REFERENCES "TelegramAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_alertEventId_fkey" FOREIGN KEY ("alertEventId") REFERENCES "AlertEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlanSet" ADD CONSTRAINT "PlanSet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_planSetId_fkey" FOREIGN KEY ("planSetId") REFERENCES "PlanSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanImport" ADD CONSTRAINT "PlanImport_planSetId_fkey" FOREIGN KEY ("planSetId") REFERENCES "PlanSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QualitySnapshot" ADD CONSTRAINT "QualitySnapshot_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "QualityRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QualityViolation" ADD CONSTRAINT "QualityViolation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "QualityRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_reportTemplateId_fkey" FOREIGN KEY ("reportTemplateId") REFERENCES "ReportTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReportDeliveryLog" ADD CONSTRAINT "ReportDeliveryLog_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
