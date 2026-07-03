import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { DeliveryStatus, Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id: number | string;
      type?: 'private' | 'group' | 'supergroup' | 'channel';
      title?: string;
      username?: string;
    };
    from?: {
      id?: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private updateOffset = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get isConfigured() {
    return Boolean(this.botToken);
  }

  private get botToken() {
    return this.config.get<string>('TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN || '';
  }

  async status(userId: string) {
    const [account, groupChats, activeCode] = await Promise.all([
      this.prisma.telegramAccount.findUnique({ where: { userId } }),
      this.prisma.telegramChat.findMany({
        where: { isActive: true },
        orderBy: { linkedAt: 'desc' },
        take: 10,
      }),
      this.prisma.telegramLinkCode.findFirst({
        where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      botConfigured: this.isConfigured,
      connected: Boolean(account?.isActive || groupChats.length),
      account,
      groupChats,
      activeCode,
    };
  }

  async createLinkCode(userId: string) {
    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    await this.prisma.telegramLinkCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    const link = await this.prisma.telegramLinkCode.create({
      data: { userId, code, expiresAt },
    });
    return {
      botConfigured: this.isConfigured,
      code: link.code,
      expiresAt: link.expiresAt,
      instruction: `Отправьте боту /start ${link.code} в личку или в нужную Telegram-группу после добавления бота.`,
    };
  }

  async createCrmUserLinkCode(crmUserId: string) {
    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    await this.prisma.telegramLinkCode.updateMany({
      where: { crmUserId, usedAt: null },
      data: { usedAt: new Date() },
    });
    const link = await this.prisma.telegramLinkCode.create({
      data: { crmUserId, code, expiresAt },
    });
    return {
      botConfigured: this.isConfigured,
      code: link.code,
      expiresAt: link.expiresAt,
      instruction: `Отправьте боту в личку: /start ${link.code}`,
    };
  }

  async processUpdates() {
    if (!this.botToken) return { processed: 0, skipped: 'TELEGRAM_BOT_TOKEN не задан' };
    const params = new URLSearchParams({
      timeout: '0',
      limit: '25',
      ...(this.updateOffset ? { offset: String(this.updateOffset) } : {}),
    });
    const response = await this.telegramRequest<{ ok: boolean; result: TelegramUpdate[] }>(`getUpdates?${params.toString()}`);
    if (!response?.ok || !Array.isArray(response.result)) return { processed: 0 };

    let processed = 0;
    for (const update of response.result) {
      this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
      const text = update.message?.text?.trim() ?? '';
      const chatId = update.message?.chat?.id == null ? '' : String(update.message.chat.id);
      const isStartCommand = this.isStartCommand(text);
      const code = this.extractLinkCode(text);
      if (!chatId || (!isStartCommand && !code)) continue;
      if (!code) {
        await this.sendChatMessage(chatId, 'Код не найден. Отправьте полную команду из сервиса или просто 6 цифр кода.');
        continue;
      }
      const linked = await this.linkByCode(code, update);
      processed += linked ? 1 : 0;
    }
    return { processed };
  }

  private isStartCommand(text: string) {
    return /^\/start(?:@\w+)?(?:\s|$)/i.test(text);
  }

  private extractLinkCode(text: string) {
    const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
    if (startMatch) return startMatch[1]?.match(/\b\d{6}\b/)?.[0] ?? '';
    return text.match(/^\d{6}$/)?.[0] ?? '';
  }

  async linkByCode(code: string, update: TelegramUpdate) {
    const chat = update.message?.chat;
    const chatId = chat?.id == null ? '' : String(chat.id);
    if (!chatId) return false;

    const linkCode = await this.prisma.telegramLinkCode.findFirst({
      where: { code, usedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true, crmUser: true },
    });
    if (!linkCode) {
      await this.sendChatMessage(chatId, 'Код не подошёл или устарел. В сервисе получите новый код.');
      return false;
    }

    if (chat?.type && chat.type !== 'private') {
      if (!linkCode.userId || !linkCode.user) {
        await this.sendChatMessage(chatId, 'Этот код нужен для личного Telegram менеджера. Отправьте его боту в личку.');
        return false;
      }
      return this.linkGroupByCode(
        { id: linkCode.id, userId: linkCode.userId, user: { email: linkCode.user.email } },
        chat,
      );
    }

    const from = update.message?.from;
    await this.prisma.$transaction(async (tx) => {
      await tx.telegramAccount.deleteMany({
        where: {
          OR: [
            ...(linkCode.userId ? [{ userId: linkCode.userId }] : []),
            ...(linkCode.crmUserId ? [{ crmUserId: linkCode.crmUserId }] : []),
            { chatId },
          ],
        },
      });
      await tx.telegramAccount.create({
        data: {
          userId: linkCode.userId ?? null,
          crmUserId: linkCode.crmUserId ?? null,
          chatId,
          username: from?.username ?? null,
          firstName: from?.first_name ?? null,
          lastName: from?.last_name ?? null,
          isActive: true,
        },
      });
      await tx.telegramLinkCode.update({ where: { id: linkCode.id }, data: { usedAt: new Date() } });
    });

    const ownerName = linkCode.user?.email ?? linkCode.crmUser?.name ?? 'amoCRM-пользователю';
    await this.sendChatMessage(chatId, `Telegram подключён к ${ownerName}.`);
    return true;
  }

  private async linkGroupByCode(
    linkCode: { id: string; userId: string; user: { email: string } },
    chat: NonNullable<NonNullable<TelegramUpdate['message']>['chat']>,
  ) {
    const chatId = String(chat.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.telegramChat.upsert({
        where: { chatId },
        create: {
          userId: linkCode.userId,
          chatId,
          type: chat.type ?? 'group',
          title: chat.title ?? null,
          username: chat.username ?? null,
          isActive: true,
        },
        update: {
          userId: linkCode.userId,
          type: chat.type ?? 'group',
          title: chat.title ?? null,
          username: chat.username ?? null,
          isActive: true,
        },
      });
      await tx.telegramLinkCode.update({ where: { id: linkCode.id }, data: { usedAt: new Date() } });
    });

    await this.sendChatMessage(chatId, 'Группа подключена к PulseBoard. Уведомления будут приходить сюда.');
    return true;
  }

  async sendMessageToUser(
    userId: string,
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    return this.sendDirectMessageToUser(userId, message, payload, alertEventId, eventKey);
  }

  async sendDirectMessageToUser(
    userId: string,
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    if (eventKey) {
      const existing = await this.prisma.notificationDelivery.findUnique({ where: { eventKey } });
      if (existing) return existing;
    }

    const account = await this.prisma.telegramAccount.findUnique({ where: { userId } });
    if (!account?.isActive) {
      return this.recordDelivery({
        eventKey,
        userId,
        status: 'SKIPPED',
        message,
        payload: { ...payload, reason: 'Telegram не подключён' },
        alertEventId,
      });
    }
    if (!this.botToken) {
      return this.recordDelivery({
        eventKey,
        userId,
        telegramAccountId: account.id,
        status: 'ERROR',
        message,
        payload: { ...payload, reason: 'TELEGRAM_BOT_TOKEN не задан' },
        alertEventId,
      });
    }

    try {
      await this.sendChatMessage(account.chatId, message);
      return this.recordDelivery({
        eventKey,
        userId,
        telegramAccountId: account.id,
        status: 'SENT',
        message,
        payload,
        alertEventId,
        sentAt: new Date(),
      });
    } catch (error: any) {
      this.logger.warn(`Telegram send failed: ${error.message}`);
      return this.recordDelivery({
        eventKey,
        userId,
        telegramAccountId: account.id,
        status: 'ERROR',
        message,
        payload,
        alertEventId,
        error: error.message,
      });
    }
  }

  async sendDirectMessageToCrmUser(
    crmUserId: string,
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    if (eventKey) {
      const existing = await this.prisma.notificationDelivery.findUnique({ where: { eventKey } });
      if (existing) return existing;
    }

    const account = await this.prisma.telegramAccount.findUnique({ where: { crmUserId } });
    if (!account?.isActive) {
      return this.recordDelivery({
        eventKey,
        telegramAccountId: account?.id,
        status: 'SKIPPED',
        message,
        payload: { ...payload, crmUserId, reason: 'Telegram не подключён' },
        alertEventId,
      });
    }
    if (!this.botToken) {
      return this.recordDelivery({
        eventKey,
        telegramAccountId: account.id,
        status: 'ERROR',
        message,
        payload: { ...payload, crmUserId, reason: 'TELEGRAM_BOT_TOKEN не задан' },
        alertEventId,
      });
    }

    try {
      await this.sendChatMessage(account.chatId, message);
      return this.recordDelivery({
        eventKey,
        telegramAccountId: account.id,
        status: 'SENT',
        message,
        payload: { ...payload, crmUserId },
        alertEventId,
        sentAt: new Date(),
      });
    } catch (error: any) {
      this.logger.warn(`Telegram send failed: ${error.message}`);
      return this.recordDelivery({
        eventKey,
        telegramAccountId: account.id,
        status: 'ERROR',
        message,
        payload: { ...payload, crmUserId },
        alertEventId,
        error: error.message,
      });
    }
  }

  async sendMessageToUsers(
    userIds: string[],
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    return Promise.all(uniqueUserIds.map((userId) =>
      this.sendMessageToUser(
        userId,
        message,
        payload,
        alertEventId,
        eventKey ? `${eventKey}:${userId}` : undefined,
      ),
    ));
  }

  async sendDirectMessageToUsers(
    userIds: string[],
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    return Promise.all(uniqueUserIds.map((userId) =>
      this.sendDirectMessageToUser(
        userId,
        message,
        payload,
        alertEventId,
        eventKey ? `${eventKey}:${userId}` : undefined,
      ),
    ));
  }

  async sendDirectMessageToCrmUsers(
    crmUserIds: string[],
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    const uniqueCrmUserIds = Array.from(new Set(crmUserIds.filter(Boolean)));
    return Promise.all(uniqueCrmUserIds.map((crmUserId) =>
      this.sendDirectMessageToCrmUser(
        crmUserId,
        message,
        payload,
        alertEventId,
        eventKey ? `${eventKey}:${crmUserId}` : undefined,
      ),
    ));
  }

  async sendMessageToGroups(
    userIds: string[],
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    return this.sendMessageToActiveGroups(userIds, message, payload, alertEventId, eventKey, false);
  }

  async sendMessageToGroupsByCrmUsers(
    crmUserIds: string[],
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    return this.sendMessageToActiveGroups([], message, payload, alertEventId, eventKey, true, crmUserIds);
  }

  async sendDirectMessageToAllConnected(
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
  ) {
    const accounts = await this.prisma.telegramAccount.findMany({
      where: { isActive: true },
      orderBy: { linkedAt: 'desc' },
    });
    if (!accounts.length) return [];

    if (!this.botToken) {
      return Promise.all(accounts.map((account) =>
        this.recordDelivery({
          eventKey: eventKey ? `${eventKey}:telegram-account:${account.id}` : undefined,
          userId: account.userId ?? undefined,
          telegramAccountId: account.id,
          status: 'ERROR',
          message,
          payload: { ...payload, reason: 'TELEGRAM_BOT_TOKEN не задан' },
          alertEventId,
        }),
      ));
    }

    return Promise.all(accounts.map(async (account) => {
      const deliveryEventKey = eventKey ? `${eventKey}:telegram-account:${account.id}` : undefined;
      if (deliveryEventKey) {
        const existing = await this.prisma.notificationDelivery.findUnique({ where: { eventKey: deliveryEventKey } });
        if (existing) return existing;
      }

      try {
        await this.sendChatMessage(account.chatId, message);
        return this.recordDelivery({
          eventKey: deliveryEventKey,
          userId: account.userId ?? undefined,
          telegramAccountId: account.id,
          status: 'SENT',
          message,
          payload,
          alertEventId,
          sentAt: new Date(),
        });
      } catch (error: any) {
        this.logger.warn(`Telegram send failed: ${error.message}`);
        return this.recordDelivery({
          eventKey: deliveryEventKey,
          userId: account.userId ?? undefined,
          telegramAccountId: account.id,
          status: 'ERROR',
          message,
          payload,
          alertEventId,
          error: error.message,
        });
      }
    }));
  }

  async mentionForCrmUser(crmUserId?: string | null, fallbackName?: string | null) {
    if (!crmUserId) return fallbackName || '-';
    const crmUser = await this.prisma.crmUser.findUnique({
      where: { id: crmUserId },
      include: { telegramAccount: true },
    });
    const username = crmUser?.telegramAccount?.username?.trim();
    if (username) return `@${username.replace(/^@/, '')}`;
    return crmUser?.name || fallbackName || '-';
  }

  async sendChatMessage(chatId: string, text: string, options: { parseMode?: 'HTML' } = {}) {
    return this.telegramRequest('sendMessage', {
      method: 'POST',
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        disable_web_page_preview: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async sendMessageToActiveGroups(
    userIds: string[],
    message: string,
    payload: Record<string, unknown> = {},
    alertEventId?: string,
    eventKey?: string,
    prependMentions = true,
    crmUserIds: string[] = [],
  ) {
    const groupChats = await this.prisma.telegramChat.findMany({ where: { isActive: true }, orderBy: { linkedAt: 'desc' } });
    if (!groupChats.length) return [];

    if (!this.botToken) {
      return Promise.all(groupChats.map((chat, index) =>
        this.recordDelivery({
          eventKey: this.groupEventKey(eventKey, chat.id, groupChats.length, index),
          telegramChatId: chat.id,
          status: 'ERROR',
          message,
          payload: { ...payload, reason: 'TELEGRAM_BOT_TOKEN не задан' },
          alertEventId,
        }),
      ));
    }

    const groupMessage = prependMentions ? await this.withMentionLine(userIds, message, crmUserIds) : { text: message };
    return Promise.all(groupChats.map(async (chat, index) => {
      const deliveryEventKey = this.groupEventKey(eventKey, chat.id, groupChats.length, index);
      if (deliveryEventKey) {
        const existing = await this.prisma.notificationDelivery.findUnique({ where: { eventKey: deliveryEventKey } });
        if (existing) return existing;
      }

      try {
        await this.sendChatMessage(chat.chatId, groupMessage.text, { parseMode: groupMessage.parseMode });
        return this.recordDelivery({
          eventKey: deliveryEventKey,
          telegramChatId: chat.id,
          status: 'SENT',
          message: groupMessage.text,
          payload,
          alertEventId,
          sentAt: new Date(),
        });
      } catch (error: any) {
        this.logger.warn(`Telegram group send failed: ${error.message}`);
        return this.recordDelivery({
          eventKey: deliveryEventKey,
          telegramChatId: chat.id,
          status: 'ERROR',
          message: groupMessage.text,
          payload,
          alertEventId,
          error: error.message,
        });
      }
    }));
  }

  private groupEventKey(eventKey: string | undefined, chatId: string, totalChats: number, index: number) {
    if (!eventKey) return undefined;
    if (totalChats === 1 && index === 0) return eventKey;
    return `${eventKey}:telegram-chat:${chatId}`;
  }

  private async withMentionLine(userIds: string[], message: string, crmUserIds: string[] = []) {
    const [userMentions, crmUserMentions] = await Promise.all([
      this.userMentions(userIds),
      this.crmUserMentions(crmUserIds),
    ]);
    const mentions = [...userMentions, ...crmUserMentions];
    if (!mentions.length) return { text: message };
    return {
      text: `Кому: ${mentions.join(', ')}\n\n${this.escapeHtml(message)}`,
      parseMode: 'HTML' as const,
    };
  }

  private async userMentions(userIds: string[]) {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    if (!uniqueUserIds.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueUserIds } },
      include: { telegramAccount: true },
    });
    return users.map((user) => {
      const username = user.telegramAccount?.username?.trim();
      if (username) return `@${this.escapeHtml(username.replace(/^@/, ''))}`;
      const chatId = user.telegramAccount?.chatId?.trim();
      if (chatId && /^\d+$/.test(chatId)) {
        return `<a href="tg://user?id=${chatId}">${this.escapeHtml(user.name)}</a>`;
      }
      return this.escapeHtml(user.name);
    });
  }

  private async crmUserMentions(crmUserIds: string[]) {
    const uniqueCrmUserIds = Array.from(new Set(crmUserIds.filter(Boolean)));
    if (!uniqueCrmUserIds.length) return [];
    const users = await this.prisma.crmUser.findMany({
      where: { id: { in: uniqueCrmUserIds } },
      include: { telegramAccount: true },
    });
    return users.map((user) => {
      const username = user.telegramAccount?.username?.trim();
      if (username) return `@${this.escapeHtml(username.replace(/^@/, ''))}`;
      const chatId = user.telegramAccount?.chatId?.trim();
      if (chatId && /^\d+$/.test(chatId)) {
        return `<a href="tg://user?id=${chatId}">${this.escapeHtml(user.name)}</a>`;
      }
      return this.escapeHtml(user.name);
    });
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private async telegramRequest<T = any>(method: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, init);
    const data = (await response.json()) as T;
    if (!response.ok) {
      throw new Error(JSON.stringify(data));
    }
    return data;
  }

  private recordDelivery(input: {
    eventKey?: string;
    userId?: string;
    telegramAccountId?: string;
    telegramChatId?: string;
    alertEventId?: string;
    status: DeliveryStatus;
    message: string;
    payload?: Record<string, unknown>;
    error?: string;
    sentAt?: Date;
  }) {
    return this.prisma.notificationDelivery.create({
      data: {
        eventKey: input.eventKey ?? null,
        userId: input.userId ?? null,
        telegramAccountId: input.telegramAccountId ?? null,
        telegramChatId: input.telegramChatId ?? null,
        alertEventId: input.alertEventId ?? null,
        status: input.status,
        message: input.message,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        error: input.error ?? null,
        sentAt: input.sentAt ?? null,
      },
    });
  }
}
