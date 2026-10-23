ALTER TABLE "WorkspaceDepartment" ADD COLUMN "paymentStageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
