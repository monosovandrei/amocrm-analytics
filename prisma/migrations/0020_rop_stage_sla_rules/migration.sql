CREATE TABLE "RopStageSlaRule" (
    "id" TEXT NOT NULL,
    "departmentKey" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "slaDays" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RopStageSlaRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RopStageSlaRule_departmentKey_stageId_key" ON "RopStageSlaRule"("departmentKey", "stageId");
CREATE INDEX "RopStageSlaRule_departmentKey_idx" ON "RopStageSlaRule"("departmentKey");
CREATE INDEX "RopStageSlaRule_stageId_idx" ON "RopStageSlaRule"("stageId");

ALTER TABLE "RopStageSlaRule" ADD CONSTRAINT "RopStageSlaRule_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
