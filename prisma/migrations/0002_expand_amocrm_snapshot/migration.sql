-- AlterEnum
ALTER TYPE "CrmEntityType" ADD VALUE 'CUSTOMER';
ALTER TYPE "CrmEntityType" ADD VALUE 'CATALOG';
ALTER TYPE "CrmEntityType" ADD VALUE 'CATALOG_ELEMENT';
ALTER TYPE "CrmEntityType" ADD VALUE 'SOURCE';

-- CreateTable
CREATE TABLE "AmoAccountSnapshot" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT,
    "subdomain" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmoAccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmRole" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTag" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "entityType" "CrmEntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityLink" (
    "id" TEXT NOT NULL,
    "entityType" "CrmEntityType" NOT NULL,
    "entityExternalId" TEXT NOT NULL,
    "linkedEntityType" TEXT NOT NULL,
    "linkedEntityExternalId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerStatus" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSegment" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "statusId" TEXT,
    "name" TEXT NOT NULL,
    "nextPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "periodicity" INTEGER,
    "responsibleId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerTransaction" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "comment" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Catalog" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "canAddElements" BOOLEAN NOT NULL DEFAULT false,
    "canShowInCards" BOOLEAN NOT NULL DEFAULT false,
    "canLinkMultiple" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogElement" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogElement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmSource" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pipelineId" TEXT,
    "originCode" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AmoAccountSnapshot_externalId_key" ON "AmoAccountSnapshot"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmRole_externalId_key" ON "CrmRole"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTag_entityType_externalId_key" ON "CrmTag"("entityType", "externalId");

-- CreateIndex
CREATE INDEX "CrmTag_entityType_name_idx" ON "CrmTag"("entityType", "name");

-- CreateIndex
CREATE UNIQUE INDEX "EntityLink_entityType_entityExternalId_linkedEntityType_linkedEntityExternalId_key" ON "EntityLink"("entityType", "entityExternalId", "linkedEntityType", "linkedEntityExternalId");

-- CreateIndex
CREATE INDEX "EntityLink_entityType_entityExternalId_idx" ON "EntityLink"("entityType", "entityExternalId");

-- CreateIndex
CREATE INDEX "EntityLink_linkedEntityType_linkedEntityExternalId_idx" ON "EntityLink"("linkedEntityType", "linkedEntityExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerStatus_externalId_key" ON "CustomerStatus"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSegment_externalId_key" ON "CustomerSegment"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalId_key" ON "Customer"("externalId");

-- CreateIndex
CREATE INDEX "Customer_statusId_idx" ON "Customer"("statusId");

-- CreateIndex
CREATE INDEX "Customer_responsibleId_idx" ON "Customer"("responsibleId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTransaction_externalId_key" ON "CustomerTransaction"("externalId");

-- CreateIndex
CREATE INDEX "CustomerTransaction_customerId_idx" ON "CustomerTransaction"("customerId");

-- CreateIndex
CREATE INDEX "CustomerTransaction_createdAt_idx" ON "CustomerTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Catalog_externalId_key" ON "Catalog"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogElement_catalogId_externalId_key" ON "CatalogElement"("catalogId", "externalId");

-- CreateIndex
CREATE INDEX "CatalogElement_catalogId_idx" ON "CatalogElement"("catalogId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmSource_externalId_key" ON "CrmSource"("externalId");

-- CreateIndex
CREATE INDEX "CrmSource_pipelineId_idx" ON "CrmSource"("pipelineId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "CustomerStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTransaction" ADD CONSTRAINT "CustomerTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogElement" ADD CONSTRAINT "CatalogElement_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
