CREATE TABLE "EmailThreadState" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "lastIncomingNoteExternalId" TEXT,
    "lastIncomingAt" TIMESTAMP(3),
    "lastOutgoingAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "subject" TEXT,
    "summary" TEXT,
    "body" TEXT,
    "from" TEXT,
    "to" TEXT,
    "attachCount" INTEGER NOT NULL DEFAULT 0,
    "deliveryStatus" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "isPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThreadState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailThreadState_dealId_threadId_key" ON "EmailThreadState"("dealId", "threadId");
CREATE INDEX "EmailThreadState_isPending_lastIncomingAt_idx" ON "EmailThreadState"("isPending", "lastIncomingAt");
CREATE INDEX "EmailThreadState_dealId_isPending_idx" ON "EmailThreadState"("dealId", "isPending");
CREATE INDEX "EmailThreadState_lastMessageAt_idx" ON "EmailThreadState"("lastMessageAt");

ALTER TABLE "EmailThreadState" ADD CONSTRAINT "EmailThreadState_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Note_type_createdAt_idx" ON "Note"("type", "createdAt");
CREATE INDEX "Note_dealId_type_idx" ON "Note"("dealId", "type");
CREATE INDEX "Note_amomail_entityId_idx" ON "Note"((raw->>'entity_id')) WHERE "type" = 'amomail_message';
