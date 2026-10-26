CREATE TABLE "WorkspaceKpiGoal" (
  "id" TEXT NOT NULL, "departmentKey" TEXT NOT NULL, "period" TEXT NOT NULL,
  "start" TEXT NOT NULL, "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL,
  "metric" TEXT NOT NULL, "value" DECIMAL(65,30) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceKpiGoal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceKpiGoal_value_check" CHECK ("value" >= 0)
);
CREATE UNIQUE INDEX "WorkspaceKpiGoal_scope_key" ON "WorkspaceKpiGoal"("departmentKey", "period", "start", "targetType", "targetId", "metric");
CREATE TABLE "WorkspaceCompetitionPeriod" (
  "id" TEXT NOT NULL, "departmentKey" TEXT NOT NULL, "month" TEXT NOT NULL,
  "mode" TEXT NOT NULL, "memberIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceCompetitionPeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceCompetitionPeriod_mode_check" CHECK ("mode" IN ('UNIQUE_DEAL', 'AMO_EVENTS'))
);
CREATE UNIQUE INDEX "WorkspaceCompetitionPeriod_departmentKey_month_key" ON "WorkspaceCompetitionPeriod"("departmentKey", "month");
CREATE TABLE "WorkspaceDisplay" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "departmentKey" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceDisplay_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceDisplay_tokenHash_key" ON "WorkspaceDisplay"("tokenHash");
CREATE INDEX "WorkspaceDisplay_expiresAt_idx" ON "WorkspaceDisplay"("expiresAt");
CREATE INDEX "CrmEvent_competition_idx" ON "CrmEvent"("createdAt", "dealId") WHERE "type" = 'lead_status_changed';
CREATE TABLE "WorkspaceInvite" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
  "accessVersion" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceInvite_userId_key" ON "WorkspaceInvite"("userId");
CREATE UNIQUE INDEX "WorkspaceInvite_tokenHash_key" ON "WorkspaceInvite"("tokenHash");
