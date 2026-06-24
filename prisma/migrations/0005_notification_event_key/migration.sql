ALTER TABLE "NotificationDelivery" ADD COLUMN "eventKey" TEXT;

CREATE UNIQUE INDEX "NotificationDelivery_eventKey_key" ON "NotificationDelivery"("eventKey");
