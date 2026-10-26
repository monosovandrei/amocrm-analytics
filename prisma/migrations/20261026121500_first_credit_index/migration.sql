CREATE INDEX "CrmEvent_first_credit_idx" ON "CrmEvent"("dealId", "createdAt") WHERE "type" = 'lead_status_changed';
