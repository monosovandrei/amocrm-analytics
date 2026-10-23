ALTER TABLE "User" ADD COLUMN "departmentKey" TEXT, ADD COLUMN "accessVersion" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "WorkspaceDepartment" (
  "key" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "groupId" TEXT NOT NULL,
  "pipelineIds" TEXT[] NOT NULL, "assemblyPipelineId" TEXT NOT NULL, "shippingStageId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "CommercialShipmentLink" (
  "shipmentDealId" TEXT PRIMARY KEY, "saleDealId" TEXT, "managerId" TEXT, "departmentKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'UNRESOLVED', "source" TEXT NOT NULL, "effectiveAt" TIMESTAMP(3),
  "evidence" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "CommercialShipmentLink_managerId_departmentKey_status_idx" ON "CommercialShipmentLink"("managerId", "departmentKey", "status");
CREATE INDEX "CommercialShipmentLink_saleDealId_idx" ON "CommercialShipmentLink"("saleDealId");
CREATE TABLE "WorkspacePlan" (
  "id" TEXT PRIMARY KEY, "month" TEXT NOT NULL, "departmentKey" TEXT NOT NULL, "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL, "metric" TEXT NOT NULL, "value" DECIMAL(65,30) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR', "version" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "WorkspacePlan_scope_key" ON "WorkspacePlan"("month", "departmentKey", "targetType", "targetId", "metric");
