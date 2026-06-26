CREATE TABLE "EmailThreadDismissal" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "lastIncomingNoteExternalId" TEXT NOT NULL,
    "lastIncomingAt" TIMESTAMP(3) NOT NULL,
    "dismissedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThreadDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailThreadDismissal_dealId_threadId_lastIncomingNoteExternalId_key" ON "EmailThreadDismissal"("dealId", "threadId", "lastIncomingNoteExternalId");
CREATE INDEX "EmailThreadDismissal_dealId_idx" ON "EmailThreadDismissal"("dealId");
CREATE INDEX "EmailThreadDismissal_lastIncomingAt_idx" ON "EmailThreadDismissal"("lastIncomingAt");

ALTER TABLE "EmailThreadDismissal" ADD CONSTRAINT "EmailThreadDismissal_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
