import * as crypto from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmoConnection, Prisma } from '../generated/prisma';
import { encryptJson, decryptJson } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { AmoClient, AmoClientFactory } from './amo-client';
import { AmoCredentials, AmoWebhookItem } from './amo.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AmoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly clients: AmoClientFactory,
    private readonly audit: AuditService,
  ) {}

  buildOAuthUrl(subdomainInput: string) {
    const domain = this.normalizeDomain(subdomainInput);
    const clientId = this.config.getOrThrow<string>('AMOCRM_CLIENT_ID');
    const redirectUri = this.config.getOrThrow<string>('AMOCRM_REDIRECT_URI');
    const state = crypto.randomBytes(16).toString('hex');
    const url = new URL('https://www.amocrm.ru/oauth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('state', state);
    url.searchParams.set('mode', 'post_message');
    url.searchParams.set('redirect_uri', redirectUri);
    return { url: url.toString(), state, domain };
  }

  async exchangeOAuthCode(subdomainInput: string, code: string, redirectUri: string, actorUserId?: string) {
    if (!redirectUri) {
      throw new BadRequestException('redirectUri обязателен');
    }

    const domain = this.normalizeDomain(subdomainInput);
    const clientId = this.config.getOrThrow<string>('AMOCRM_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('AMOCRM_CLIENT_SECRET');

    const tokenRes = await fetch(`https://${domain}/oauth2/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw new BadRequestException(`amoCRM OAuth error ${tokenRes.status}: ${await tokenRes.text()}`);
    }

    const tokens = await tokenRes.json();
    const credentials: AmoCredentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
    };

    const client = this.clients.create({
      domain,
      credentials,
      clientId,
      clientSecret,
      redirectUri,
    });
    const account = await client.get<any>('/account');
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const existing = await this.prisma.amoConnection.findFirst();
    const data = {
      subdomain: domain,
      accountId: account?.id ? String(account.id) : null,
      accountName: account?.name ?? null,
      credentials: this.encryptCredentials(credentials),
      webhookSecret,
      status: 'ACTIVE' as const,
      lastError: null,
      config: {
        redirectUri,
        webhookUrl: this.getWebhookUrl(webhookSecret),
      },
    };

    const connection = existing
      ? await this.prisma.amoConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.amoConnection.create({ data });

    await this.audit.record({
      userId: actorUserId,
      action: existing ? 'amo.connection.update' : 'amo.connection.create',
      entity: 'AmoConnection',
      entityId: connection.id,
      metadata: { subdomain: domain, accountId: connection.accountId },
    });

    return this.toPublicConnection(connection);
  }

  async getConnection() {
    const connection = await this.prisma.amoConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    return connection ? this.toPublicConnection(connection) : null;
  }

  async getActiveConnectionOrFail() {
    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'SYNCING', 'ERROR'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection) {
      throw new NotFoundException('amoCRM не подключена');
    }
    return connection;
  }

  async getClient(connection: AmoConnection): Promise<AmoClient> {
    const clientId = this.config.getOrThrow<string>('AMOCRM_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('AMOCRM_CLIENT_SECRET');
    const redirectUri =
      (connection.config as any)?.redirectUri ??
      this.config.getOrThrow<string>('AMOCRM_REDIRECT_URI');
    const credentials = this.decryptCredentials(connection.credentials);

    return this.clients.create({
      domain: connection.subdomain,
      credentials,
      clientId,
      clientSecret,
      redirectUri,
      onCredentialsChanged: async (nextCredentials) => {
        await this.prisma.amoConnection.update({
          where: { id: connection.id },
          data: { credentials: this.encryptCredentials(nextCredentials) },
        });
      },
    });
  }

  async findByWebhookSecret(secret: string) {
    if (!secret) return null;
    const connections = await this.prisma.amoConnection.findMany({
      where: { status: { in: ['ACTIVE', 'SYNCING', 'ERROR'] } },
    });
    const incoming = Buffer.from(secret);

    for (const connection of connections) {
      const stored = Buffer.from(connection.webhookSecret);
      if (stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming)) {
        return connection;
      }
    }

    return null;
  }

  flattenWebhook(body: any): AmoWebhookItem[] {
    const events: AmoWebhookItem[] = [];
    const normalizedBody = this.normalizeWebhookBody(body);
    for (const [entity, actions] of Object.entries(normalizedBody ?? {})) {
      if (entity === 'account') continue;
      if (!actions || typeof actions !== 'object') continue;

      for (const [action, rawItems] of Object.entries(actions as Record<string, unknown>)) {
        const items = this.normalizeWebhookItems(rawItems);
        for (const item of items) {
          const externalId = this.webhookExternalId(entity, action, item);
          events.push({
            entity,
            action,
            externalId: externalId === null || externalId === undefined ? null : String(externalId),
            payload: item,
          });
        }
      }
    }
    return events;
  }

  async recordWebhook(connectionId: string, events: AmoWebhookItem[]) {
    if (events.length === 0) return;
    await this.prisma.webhookEvent.createMany({
      data: events.map((event) => ({
        connectionId,
        entity: event.entity,
        action: event.action,
        externalId: event.externalId,
        payload: event.payload as Prisma.InputJsonValue,
      })),
    });
  }

  validateWebhookAccount(body: any, connection: AmoConnection) {
    const normalizedBody = this.normalizeWebhookBody(body);
    const payloadSubdomain = normalizedBody?.account?.[0]?.subdomain ?? normalizedBody?.account?.subdomain;
    if (!payloadSubdomain) return true;
    return this.normalizeDomain(String(payloadSubdomain)) === this.normalizeDomain(connection.subdomain);
  }

  toPublicConnection(connection: AmoConnection) {
    return {
      id: connection.id,
      subdomain: connection.subdomain,
      accountId: connection.accountId,
      accountName: connection.accountName,
      status: connection.status,
      syncIntervalMinutes: connection.syncIntervalMinutes,
      lastFullSyncAt: connection.lastFullSyncAt,
      lastIncrementalSyncAt: connection.lastIncrementalSyncAt,
      lastError: connection.lastError,
      webhookUrl: (connection.config as any)?.webhookUrl ?? this.getWebhookUrl(connection.webhookSecret),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  private normalizeDomain(input: string) {
    const clean = input
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim()
      .toLowerCase();
    const domain = clean.includes('.') ? clean : `${clean}.amocrm.ru`;
    if (!/^[a-z0-9-]+\.amocrm\.(ru|com)$/.test(domain)) {
      throw new BadRequestException('Введите корректный домен amoCRM');
    }
    return domain;
  }

  private normalizeWebhookItems(raw: unknown): Array<Record<string, any>> {
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) return raw as Array<Record<string, any>>;
    if (typeof raw !== 'object') return [{ id: raw }];

    const values = Object.values(raw as Record<string, unknown>);
    if (values.length > 0 && values.every((value) => typeof value === 'object')) {
      return values as Array<Record<string, any>>;
    }

    return [raw as Record<string, any>];
  }

  private normalizeWebhookBody(body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const entries = Object.entries(body);
    if (!entries.some(([key]) => key.includes('['))) return body;

    const result: Record<string, any> = {};
    for (const [key, value] of entries) {
      const path = this.parseFormBodyPath(key);
      if (path.length === 0) {
        result[key] = value;
        continue;
      }
      this.setWebhookBodyValue(result, path, value);
    }
    return result;
  }

  private parseFormBodyPath(key: string) {
    const path: string[] = [];
    const first = key.match(/^[^\[]+/)?.[0];
    if (first) path.push(first);
    for (const match of key.matchAll(/\[([^\]]*)\]/g)) {
      if (match[1]) path.push(match[1]);
    }
    return path;
  }

  private setWebhookBodyValue(target: Record<string, any>, path: string[], value: unknown) {
    let current: Record<string, any> = target;
    path.forEach((part, index) => {
      if (index === path.length - 1) {
        current[part] = value;
        return;
      }
      if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
        current[part] = current[part] === undefined ? {} : { value: current[part] };
      }
      current = current[part];
    });
  }

  private webhookExternalId(entity: string, action: string, item: Record<string, any>) {
    const normalizedEntity = String(entity ?? '').toLowerCase();
    const normalizedAction = String(action ?? '').toLowerCase();
    if (normalizedEntity.includes('message')) return item.contact_id ?? item.element_id ?? null;
    if (normalizedAction.includes('note')) {
      const note = item.note && typeof item.note === 'object' && !Array.isArray(item.note)
        ? item.note as Record<string, any>
        : null;
      return note?.element_id ?? note?.entity_id ?? item.element_id ?? item.entity_id ?? item.lead_id ?? item.contact_id ?? item.company_id ?? item.customer_id ?? null;
    }
    if (normalizedEntity.includes('task')) return item.task_id ?? item.id ?? item.entity_id ?? null;
    return item.id ?? item.uid ?? item.entity_id ?? item.task_id ?? item.element_id ?? null;
  }

  private encryptCredentials(credentials: AmoCredentials) {
    return encryptJson(credentials, this.config.getOrThrow<string>('CREDENTIALS_ENCRYPTION_KEY'));
  }

  private decryptCredentials(encrypted: string) {
    return decryptJson<AmoCredentials>(encrypted, this.config.getOrThrow<string>('CREDENTIALS_ENCRYPTION_KEY'));
  }

  private getWebhookUrl(secret: string) {
    const base = this.config.get<string>('WEBHOOK_BASE_URL', '').replace(/\/$/, '');
    return base ? `${base}/webhooks/amocrm/${secret}` : `/api/v1/webhooks/amocrm/${secret}`;
  }
}
