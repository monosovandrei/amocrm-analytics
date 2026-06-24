CREATE TABLE "TelegramChat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'group',
    "title" TEXT,
    "username" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChat_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "NotificationDelivery" ADD COLUMN "telegramChatId" TEXT;

CREATE UNIQUE INDEX "TelegramChat_chatId_key" ON "TelegramChat"("chatId");
CREATE INDEX "TelegramChat_userId_isActive_idx" ON "TelegramChat"("userId", "isActive");
CREATE INDEX "NotificationDelivery_telegramChatId_idx" ON "NotificationDelivery"("telegramChatId");

ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_telegramChatId_fkey" FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
