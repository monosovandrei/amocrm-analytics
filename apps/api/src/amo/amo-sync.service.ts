import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SyncJobType } from '../generated/prisma';
import { toDateFromAmoTimestamp } from '../common/date.util';
import { PrismaService } from '../prisma/prisma.service';
import { AmoClient } from './amo-client';
import { AmoService } from './amo.service';
import { AmoSyncMaps } from './amo.types';
import { AuditService } from '../audit/audit.service';
import { CrmEventNotificationsService } from '../platform/crm-event-notifications.service';

@Injectable()
export class AmoSyncService {
  private static readonly DEFAULT_STALE_SYNC_JOB_MS = 10 * 60 * 1000;
  private readonly logger = new Logger(AmoSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly amo: AmoService,
    private readonly audit: AuditService,
    private readonly crmEventNotifications: CrmEventNotificationsService,
    private readonly config: ConfigService,
  ) {}

  async trigger(type: SyncJobType, actorUserId?: string) {
    const connection = await this.amo.getActiveConnectionOrFail();
    await this.expireStaleJobs(connection.id);

    const runningJob = await this.prisma.syncJob.findFirst({
      where: {
        connectionId: connection.id,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (runningJob) {
      return { jobId: runningJob.id, status: runningJob.status, type: runningJob.type };
    }

    const job = await this.prisma.syncJob.create({
      data: { connectionId: connection.id, type, status: 'QUEUED' },
    });
    await this.audit.record({
      userId: actorUserId,
      action: 'amo.sync.trigger',
      entity: 'SyncJob',
      entityId: job.id,
      metadata: { type, connectionId: connection.id },
    });

    this.run(job.id).catch((error) => {
      this.logger.error(`amoCRM sync job ${job.id} failed: ${error.message}`, error.stack);
    });

    return { jobId: job.id, status: job.status, type: job.type };
  }

  async expireStaleJobs(connectionId: string) {
    const cutoff = new Date(Date.now() - this.getStaleSyncJobMs());
    const expired = await this.prisma.syncJob.updateMany({
      where: {
        connectionId,
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: [
          { startedAt: { lt: cutoff } },
          { startedAt: null, createdAt: { lt: cutoff } },
        ],
      },
      data: {
        status: 'ERROR',
        finishedAt: new Date(),
        error: 'Синхронизация была прервана и закрыта автоматически',
      },
    });

    if (expired.count > 0) {
      await this.prisma.amoConnection.update({
        where: { id: connectionId },
        data: { status: 'ACTIVE', lastError: null },
      });
      this.logger.warn(`Closed ${expired.count} stale amoCRM sync job(s)`);
    }

    return expired.count;
  }

  private getStaleSyncJobMs() {
    const rawTimeout = this.config.get<string>('AMOCRM_SYNC_JOB_TIMEOUT_MINUTES');
    if (!rawTimeout) return AmoSyncService.DEFAULT_STALE_SYNC_JOB_MS;

    const parsed = Number(rawTimeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return AmoSyncService.DEFAULT_STALE_SYNC_JOB_MS;
    }

    return parsed * 60_000;
  }

  async getJob(id: string) {
    return this.prisma.syncJob.findUnique({ where: { id } });
  }

  async run(jobId: string) {
    const job = await this.prisma.syncJob.findUnique({
      where: { id: jobId },
      include: { connection: true },
    });
    if (!job) return;

    await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await this.prisma.amoConnection.update({
      where: { id: job.connectionId },
      data: { status: 'SYNCING', lastError: null },
    });

    const stats: Record<string, number> = {};

    try {
      const client = await this.amo.getClient(job.connection);
      const syncStartedAt = new Date();
      const updatedSince = this.getUpdatedSince(job.type, job.connection.lastIncrementalSyncAt);
      const notificationSince = job.connection.lastIncrementalSyncAt
        ? new Date(job.connection.lastIncrementalSyncAt.getTime() - 5 * 60_000)
        : syncStartedAt;

      await this.syncAccount(client, stats);
      const maps = await this.syncMetadata(client, stats);
      await this.syncOptional('sources', stats, () => this.syncSources(client, maps, stats));
      await this.syncOptional('tags', stats, () => this.syncTags(client, stats));
      await this.syncOptional('catalogs', stats, () => this.syncCatalogs(client, stats));
      await this.syncOptional('customersMetadata', stats, () => this.syncCustomerMetadata(client, maps, stats));
      await this.syncCustomFieldDefinitions(client, stats);
      await this.hydrateExistingEntityMaps(maps);
      this.logger.log(`amoCRM sync job ${jobId}: syncing deals`);
      await this.syncDeals(client, maps, stats, updatedSince);
      await this.reconcileLeadSlaDeals(client, maps, stats);
      this.logger.log(`amoCRM sync job ${jobId}: syncing notes`);
      await this.syncNotes(client, stats, updatedSince);
      this.logger.log(`amoCRM sync job ${jobId}: syncing events`);
      await this.syncEvents(client, maps, stats, updatedSince);
      this.logger.log(`amoCRM sync job ${jobId}: syncing tasks`);
      await this.syncOptional('tasks', stats, () => this.syncTasks(client, maps, stats, updatedSince));
      this.logger.log(`amoCRM sync job ${jobId}: syncing contacts and companies`);
      await this.syncContacts(client, maps, stats, updatedSince);
      await this.syncCompanies(client, maps, stats, updatedSince);
      await this.syncOptional('customers', stats, () => this.syncCustomers(client, maps, stats, updatedSince));
      await this.syncOptional('entityLinks', stats, () => this.syncEntityLinks(client, stats));
      await this.recalculateStageProbabilities();
      await this.processCrmNotifications(stats, notificationSince, client.domain);

      const syncFinishedAt = new Date();
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'SUCCESS', finishedAt: syncFinishedAt, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: {
          status: 'ACTIVE',
          lastError: null,
          lastFullSyncAt: job.type === 'FULL' ? syncFinishedAt : job.connection.lastFullSyncAt,
          lastIncrementalSyncAt: syncStartedAt,
        },
      });
    } catch (error: any) {
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'ERROR', finishedAt: new Date(), error: error.message, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: { status: 'ERROR', lastError: error.message },
      });
      throw error;
    }
  }

  private getUpdatedSince(type: SyncJobType, lastIncrementalSyncAt: Date | null): number | undefined {
    if (type === 'FULL' || !lastIncrementalSyncAt) return undefined;
    return Math.floor((lastIncrementalSyncAt.getTime() - 5 * 60_000) / 1000);
  }

  private emptyMaps(): AmoSyncMaps {
    return {
      pipelines: new Map(),
      stages: new Map(),
      users: new Map(),
      contacts: new Map(),
      companies: new Map(),
      lossReasons: new Map(),
      customerStatuses: new Map(),
      customers: new Map(),
    };
  }

  private async syncOptional(name: string, stats: Record<string, number>, action: () => Promise<void>) {
    try {
      await action();
    } catch (error: any) {
      stats[`${name}Skipped`] = 1;
      this.logger.warn(`${name} sync skipped: ${error.message}`);
    }
  }

  private async processCrmNotifications(stats: Record<string, number>, since: Date, domain: string) {
    try {
      const result = await this.crmEventNotifications.processRecentAmoEvents({ since, domain });
      stats.notificationsChecked = result.checked;
      stats.paymentNotifications = result.payment;
      stats.workAcceptedNotifications = result.workAccepted;
      stats.assignedLeadNewNotifications = result.assignedLeadNew;
      stats.assignedLeadReminderNotifications = result.assignedLeadReminder;
      stats.taskMassMoveNotifications = result.taskMassMove;
      stats.csmTaskMassMoveNotifications = result.csmTaskMassMove;
      stats.csmDealMassMoveNotifications = result.csmDealMassMove;
      stats.csmOverdueTaskNotifications = result.csmOverdueTasks;
      stats.csmZeroTakenToWorkNotifications = result.csmZeroTakenToWork;
      stats.csmZeroOfferMadeNotifications = result.csmZeroOfferMade;
      stats.invoiceNoPaymentNotifications = result.invoiceNoPayment;
      stats.proposalStaleNotifications = result.proposalStale;
      stats.notificationSkips = result.skipped;
    } catch (error: any) {
      stats.notificationErrors = 1;
      this.logger.warn(`CRM notifications skipped: ${error.message}`);
    }
  }

  private async syncAccount(client: AmoClient, stats: Record<string, number>) {
    const account = await client.get<any>('/account');
    const externalId = account?.id ? String(account.id) : client.domain;
    await this.prisma.amoAccountSnapshot.upsert({
      where: { externalId },
      create: {
        externalId,
        name: account?.name ?? null,
        subdomain: account?.subdomain ?? client.domain,
        raw: account ?? {},
      },
      update: {
        name: account?.name ?? null,
        subdomain: account?.subdomain ?? client.domain,
        raw: account ?? {},
      },
    });
    stats.account = 1;
  }

  private async syncMetadata(client: AmoClient, stats: Record<string, number>): Promise<AmoSyncMaps> {
    const maps = this.emptyMaps();

    const pipelines = await client.paginate<any>('/leads/pipelines', 'pipelines');
    for (const pipeline of pipelines) {
      const dbPipeline = await this.prisma.pipeline.upsert({
        where: { externalId: String(pipeline.id) },
        create: {
          externalId: String(pipeline.id),
          name: pipeline.name,
          isArchived: Boolean(pipeline.is_archive),
          raw: pipeline,
        },
        update: {
          name: pipeline.name,
          isArchived: Boolean(pipeline.is_archive),
          raw: pipeline,
        },
      });
      maps.pipelines.set(String(pipeline.id), dbPipeline.id);

      for (const status of pipeline._embedded?.statuses ?? []) {
        const statusExternalId = String(status.id);
        const isWon = status.type === 'win' || statusExternalId === '142';
        const isLost = status.type === 'loss' || statusExternalId === '143';
        const dbStage = await this.prisma.pipelineStage.upsert({
          where: {
            pipelineId_externalId: {
              pipelineId: dbPipeline.id,
              externalId: statusExternalId,
            },
          },
          create: {
            pipelineId: dbPipeline.id,
            externalId: statusExternalId,
            name: status.name,
            position: Number(status.sort ?? 0),
            color: status.color ?? null,
            isWon,
            isLost,
            raw: status,
          },
          update: {
            name: status.name,
            position: Number(status.sort ?? 0),
            color: status.color ?? null,
            isWon,
            isLost,
            raw: status,
          },
        });
        maps.stages.set(`${pipeline.id}_${status.id}`, dbStage.id);
      }

      await this.syncLossReasons(client, dbPipeline.id, String(pipeline.id), maps);
    }

    const accountWithGroups = await client.get<any>('/account', { with: 'users_groups' });
    const groupNames = new Map<string, string>();
    for (const group of accountWithGroups?._embedded?.users_groups ?? []) {
      const externalId = String(group.id);
      if (externalId === '0') continue;
      const dbGroup = await this.prisma.crmGroup.upsert({
        where: { externalId },
        create: { externalId, name: group.name || `Group ${externalId}`, raw: group },
        update: { name: group.name || `Group ${externalId}`, raw: group },
      });
      groupNames.set(externalId, dbGroup.name);
    }

    const users = await client.paginate<any>('/users', 'users', { with: 'group' });
    for (const user of users) {
      const groupExternalId = user.rights?.group_id ? String(user.rights.group_id) : null;
      let groupId: string | null = null;
      if (groupExternalId) {
        const groupName =
          groupNames.get(groupExternalId) ??
          user._embedded?.group?.name ??
          user.rights?.group_name ??
          `Group ${groupExternalId}`;
        const group = await this.prisma.crmGroup.upsert({
          where: { externalId: groupExternalId },
          create: { externalId: groupExternalId, name: groupName, raw: user._embedded?.group ?? user.rights ?? {} },
          update: { name: groupName, raw: user._embedded?.group ?? user.rights ?? {} },
        });
        groupId = group.id;
      }

      const isActive = user.rights?.is_active !== false && user.is_free !== true;
      const dbUser = await this.prisma.crmUser.upsert({
        where: { externalId: String(user.id) },
        create: {
          externalId: String(user.id),
          groupId,
          name: user.name || user.email || `Менеджер ${user.id}`,
          email: user.email ?? null,
          isActive,
          raw: user,
        },
        update: {
          groupId,
          name: user.name || user.email || `Менеджер ${user.id}`,
          email: user.email ?? null,
          isActive,
          raw: user,
        },
      });
      maps.users.set(String(user.id), dbUser.id);
    }

    await this.syncOptional('roles', stats, async () => {
      const roles = await client.paginate<any>('/roles', 'roles');
      for (const role of roles) {
        await this.prisma.crmRole.upsert({
          where: { externalId: String(role.id) },
          create: {
            externalId: String(role.id),
            name: role.name || `Роль ${role.id}`,
            raw: role,
          },
          update: {
            name: role.name || `Роль ${role.id}`,
            raw: role,
          },
        });
      }
      stats.roles = roles.length;
    });

    stats.pipelines = maps.pipelines.size;
    stats.stages = maps.stages.size;
    stats.users = maps.users.size;
    return maps;
  }

  private async syncSources(client: AmoClient, maps: AmoSyncMaps, stats: Record<string, number>) {
    const sources = await client.paginate<any>('/sources', 'sources');
    for (const source of sources) {
      await this.prisma.crmSource.upsert({
        where: { externalId: String(source.id) },
        create: {
          externalId: String(source.id),
          name: source.name || `Источник ${source.id}`,
          pipelineId: source.pipeline_id ? maps.pipelines.get(String(source.pipeline_id)) ?? null : null,
          originCode: source.origin_code ?? null,
          isDefault: Boolean(source.default),
          raw: source,
        },
        update: {
          name: source.name || `Источник ${source.id}`,
          pipelineId: source.pipeline_id ? maps.pipelines.get(String(source.pipeline_id)) ?? null : null,
          originCode: source.origin_code ?? null,
          isDefault: Boolean(source.default),
          raw: source,
        },
      });
    }
    stats.sources = sources.length;
  }

  private async syncTags(client: AmoClient, stats: Record<string, number>) {
    const sources: Array<{ entityType: 'LEAD' | 'CONTACT' | 'COMPANY' | 'CUSTOMER'; path: string; key: string }> = [
      { entityType: 'LEAD', path: '/leads/tags', key: 'tags' },
      { entityType: 'CONTACT', path: '/contacts/tags', key: 'tags' },
      { entityType: 'COMPANY', path: '/companies/tags', key: 'tags' },
      { entityType: 'CUSTOMER', path: '/customers/tags', key: 'tags' },
    ];

    let count = 0;
    for (const source of sources) {
      await this.syncOptional(`${source.entityType.toLowerCase()}Tags`, stats, async () => {
        const tags = await client.paginate<any>(source.path, source.key);
        for (const tag of tags) {
          await this.prisma.crmTag.upsert({
            where: {
              entityType_externalId: {
                entityType: source.entityType,
                externalId: String(tag.id ?? tag.name),
              },
            },
            create: {
              entityType: source.entityType,
              externalId: String(tag.id ?? tag.name),
              name: tag.name || `Тег ${tag.id}`,
              color: tag.color ?? null,
              raw: tag,
            },
            update: {
              name: tag.name || `Тег ${tag.id}`,
              color: tag.color ?? null,
              raw: tag,
            },
          });
        }
        count += tags.length;
      });
    }
    stats.tags = count;
  }

  private async syncCatalogs(client: AmoClient, stats: Record<string, number>) {
    const catalogs = await client.paginate<any>('/catalogs', 'catalogs');
    let elementCount = 0;
    for (const catalog of catalogs) {
      const dbCatalog = await this.prisma.catalog.upsert({
        where: { externalId: String(catalog.id) },
        create: {
          externalId: String(catalog.id),
          name: catalog.name || `Список ${catalog.id}`,
          type: catalog.type ?? null,
          sort: Number(catalog.sort ?? 0),
          canAddElements: Boolean(catalog.can_add_elements),
          canShowInCards: Boolean(catalog.can_show_in_cards),
          canLinkMultiple: Boolean(catalog.can_link_multiple),
          raw: catalog,
        },
        update: {
          name: catalog.name || `Список ${catalog.id}`,
          type: catalog.type ?? null,
          sort: Number(catalog.sort ?? 0),
          canAddElements: Boolean(catalog.can_add_elements),
          canShowInCards: Boolean(catalog.can_show_in_cards),
          canLinkMultiple: Boolean(catalog.can_link_multiple),
          raw: catalog,
        },
      });

      const elements = await client.paginate<any>(`/catalogs/${catalog.id}/elements`, 'elements');
      for (const element of elements) {
        await this.prisma.catalogElement.upsert({
          where: {
            catalogId_externalId: {
              catalogId: dbCatalog.id,
              externalId: String(element.id),
            },
          },
          create: {
            catalogId: dbCatalog.id,
            externalId: String(element.id),
            name: element.name || `Элемент ${element.id}`,
            customFields: this.parseCustomFields(element.custom_fields_values),
            raw: element,
            createdAt: toDateFromAmoTimestamp(element.created_at) ?? new Date(),
          },
          update: {
            name: element.name || `Элемент ${element.id}`,
            customFields: this.parseCustomFields(element.custom_fields_values),
            raw: element,
          },
        });
      }
      elementCount += elements.length;
    }
    stats.catalogs = catalogs.length;
    stats.catalogElements = elementCount;
  }

  private async syncCustomerMetadata(client: AmoClient, maps: AmoSyncMaps, stats: Record<string, number>) {
    await this.syncOptional('customerStatuses', stats, async () => {
      const statuses = await client.paginate<any>('/customers/statuses', 'statuses');
      for (const status of statuses) {
        const dbStatus = await this.prisma.customerStatus.upsert({
          where: { externalId: String(status.id) },
          create: {
            externalId: String(status.id),
            name: status.name || `Статус ${status.id}`,
            sort: Number(status.sort ?? 0),
            color: status.color ?? null,
            raw: status,
          },
          update: {
            name: status.name || `Статус ${status.id}`,
            sort: Number(status.sort ?? 0),
            color: status.color ?? null,
            raw: status,
          },
        });
        maps.customerStatuses.set(String(status.id), dbStatus.id);
      }
      stats.customerStatuses = statuses.length;
    });

    await this.syncOptional('customerSegments', stats, async () => {
      const segments = await client.paginate<any>('/customers/segments', 'segments');
      for (const segment of segments) {
        await this.prisma.customerSegment.upsert({
          where: { externalId: String(segment.id) },
          create: {
            externalId: String(segment.id),
            name: segment.name || `Сегмент ${segment.id}`,
            raw: segment,
          },
          update: {
            name: segment.name || `Сегмент ${segment.id}`,
            raw: segment,
          },
        });
      }
      stats.customerSegments = segments.length;
    });
  }

  private async syncLossReasons(client: AmoClient, pipelineId: string, pipelineExternalId: string, maps: AmoSyncMaps) {
    try {
      const data = await client.get<any>(`/leads/pipelines/${pipelineExternalId}/loss_reasons`);
      for (const reason of data?._embedded?.loss_reasons ?? []) {
        const dbReason = await this.prisma.lossReason.upsert({
          where: {
            pipelineId_externalId: {
              pipelineId,
              externalId: String(reason.id),
            },
          },
          create: { pipelineId, externalId: String(reason.id), name: reason.name, raw: reason },
          update: { name: reason.name, raw: reason },
        });
        maps.lossReasons.set(`${pipelineExternalId}_${reason.id}`, dbReason.id);
      }
    } catch (error: any) {
      this.logger.warn(`Loss reasons sync skipped for pipeline ${pipelineExternalId}: ${error.message}`);
    }
  }

  private async syncCustomFieldDefinitions(client: AmoClient, stats: Record<string, number>) {
    const sources: Array<{ entity: 'LEAD' | 'CONTACT' | 'COMPANY' | 'CUSTOMER'; path: string; key: string }> = [
      { entity: 'LEAD', path: '/leads/custom_fields', key: 'custom_fields' },
      { entity: 'CONTACT', path: '/contacts/custom_fields', key: 'custom_fields' },
      { entity: 'COMPANY', path: '/companies/custom_fields', key: 'custom_fields' },
      { entity: 'CUSTOMER', path: '/customers/custom_fields', key: 'custom_fields' },
    ];

    let count = 0;
    for (const source of sources) {
      await this.syncOptional(`${source.entity.toLowerCase()}CustomFields`, stats, async () => {
        const fields = await client.paginate<any>(source.path, source.key);
        for (const field of fields) {
          await this.prisma.customFieldDefinition.upsert({
            where: {
              entityType_externalId: {
                entityType: source.entity,
                externalId: String(field.id),
              },
            },
            create: {
              entityType: source.entity,
              externalId: String(field.id),
              code: field.code ?? null,
              name: field.name,
              type: field.type,
              enums: field.enums ?? [],
              raw: field,
            },
            update: {
              code: field.code ?? null,
              name: field.name,
              type: field.type,
              enums: field.enums ?? [],
              raw: field,
            },
          });
        }
        count += fields.length;
      });
    }
    stats.customFields = count;
  }

  private async syncCompanies(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    const companies = await client.paginate<any>('/companies', 'companies', params);
    for (const company of companies) {
      const dbCompany = await this.prisma.crmCompany.upsert({
        where: { externalId: String(company.id) },
        create: {
          externalId: String(company.id),
          name: company.name || `Компания ${company.id}`,
          customFields: this.parseCustomFields(company.custom_fields_values),
          raw: company,
        },
        update: {
          name: company.name || `Компания ${company.id}`,
          customFields: this.parseCustomFields(company.custom_fields_values),
          raw: company,
        },
      });
      maps.companies.set(String(company.id), dbCompany.id);
    }
    stats.companies = companies.length;
  }

  private async hydrateExistingEntityMaps(maps: AmoSyncMaps) {
    const [contacts, companies] = await Promise.all([
      this.prisma.contact.findMany({ select: { id: true, externalId: true } }),
      this.prisma.crmCompany.findMany({ select: { id: true, externalId: true } }),
    ]);
    for (const contact of contacts) maps.contacts.set(contact.externalId, contact.id);
    for (const company of companies) maps.companies.set(company.externalId, company.id);
  }

  private async syncContacts(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    const contacts = await client.paginate<any>('/contacts', 'contacts', params);
    for (const contact of contacts) {
      const fields = this.parseCustomFields(contact.custom_fields_values);
      const dbContact = await this.prisma.contact.upsert({
        where: { externalId: String(contact.id) },
        create: {
          externalId: String(contact.id),
          name: contact.name || `Контакт ${contact.id}`,
          phone: this.findFieldValue(contact.custom_fields_values, 'PHONE'),
          email: this.findFieldValue(contact.custom_fields_values, 'EMAIL'),
          customFields: fields,
          raw: contact,
          createdAt: toDateFromAmoTimestamp(contact.created_at) ?? new Date(),
        },
        update: {
          name: contact.name || `Контакт ${contact.id}`,
          phone: this.findFieldValue(contact.custom_fields_values, 'PHONE'),
          email: this.findFieldValue(contact.custom_fields_values, 'EMAIL'),
          customFields: fields,
          raw: contact,
        },
      });
      maps.contacts.set(String(contact.id), dbContact.id);
    }
    stats.contacts = contacts.length;
  }

  private async syncDeals(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params: Record<string, string | number> = { with: 'contacts,catalog_elements,loss_reason' };
    if (updatedSince) params['filter[updated_at][from]'] = updatedSince;

    const leads = await client.paginate<any>('/leads', 'leads', params);
    for (const lead of leads) {
      await this.upsertDeal(lead, maps);
    }
    stats.deals = leads.length;
  }

  private async reconcileLeadSlaDeals(client: AmoClient, maps: AmoSyncMaps, stats: Record<string, number>) {
    const candidates = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        pipeline: { isArchived: false, name: { contains: '\u043f\u0440\u043e\u0434\u0430\u0436', mode: 'insensitive' } },
        stage: { isWon: false, isLost: false, name: { contains: '\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d', mode: 'insensitive' } },
      },
      include: {
        pipeline: true,
        stage: true,
      },
      take: 1000,
    });

    const slaCandidates = candidates.filter((deal) =>
      this.isSalesPipelineName(deal.pipeline?.name) && this.isAssignedResponsibleStageName(deal.stage?.name),
    );

    let checked = 0;
    let removed = 0;
    let refreshed = 0;
    for (const deal of slaCandidates) {
      checked += 1;
      try {
        const lead = await client.get<any>(`/leads/${deal.externalId}`, { with: 'contacts,catalog_elements,loss_reason' });
        if (!lead) {
          await this.prisma.deal.update({
            where: { id: deal.id },
            data: { deletedAt: new Date(), updatedAt: new Date() },
          });
          removed += 1;
          continue;
        }

        await this.upsertDeal(lead, maps);
        refreshed += 1;
      } catch (error: any) {
        if (String(error?.message ?? '').includes('amoCRM API 404')) {
          await this.prisma.deal.update({
            where: { id: deal.id },
            data: { deletedAt: new Date(), updatedAt: new Date() },
          });
          removed += 1;
        } else {
          this.logger.warn(`Lead SLA reconcile skipped for ${deal.externalId}: ${error.message}`);
        }
      }
    }

    stats.leadSlaReconcileChecked = checked;
    stats.leadSlaReconcileRemoved = removed;
    stats.leadSlaReconcileRefreshed = refreshed;
  }

  private async syncCustomers(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    const customers = await client.paginate<any>('/customers', 'customers', params);
    let transactionCount = 0;

    for (const customer of customers) {
      const statusId = customer.status_id ? maps.customerStatuses.get(String(customer.status_id)) ?? null : null;
      const dbCustomer = await this.prisma.customer.upsert({
        where: { externalId: String(customer.id) },
        create: {
          externalId: String(customer.id),
          statusId,
          name: customer.name || `Покупатель ${customer.id}`,
          nextPrice: Number(customer.next_price ?? 0),
          periodicity: customer.periodicity ? Number(customer.periodicity) : null,
          responsibleId: customer.responsible_user_id ? maps.users.get(String(customer.responsible_user_id)) ?? null : null,
          customFields: this.parseCustomFields(customer.custom_fields_values),
          raw: customer,
          createdAt: toDateFromAmoTimestamp(customer.created_at) ?? new Date(),
        },
        update: {
          statusId,
          name: customer.name || `Покупатель ${customer.id}`,
          nextPrice: Number(customer.next_price ?? 0),
          periodicity: customer.periodicity ? Number(customer.periodicity) : null,
          responsibleId: customer.responsible_user_id ? maps.users.get(String(customer.responsible_user_id)) ?? null : null,
          customFields: this.parseCustomFields(customer.custom_fields_values),
          raw: customer,
        },
      });
      maps.customers.set(String(customer.id), dbCustomer.id);

      transactionCount += await this.syncCustomerTransactions(client, dbCustomer.id, String(customer.id));
    }

    stats.customers = customers.length;
    stats.customerTransactions = transactionCount;
  }

  private isSalesPipelineName(name?: string | null) {
    return this.normalizeText(name).includes(this.normalizeText('\u043f\u0440\u043e\u0434\u0430\u0436'));
  }

  private isAssignedResponsibleStageName(name?: string | null) {
    const normalized = this.normalizeText(name);
    return normalized.includes(this.normalizeText('\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d')) &&
      normalized.includes(this.normalizeText('\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0439'));
  }

  private normalizeText(value?: string | null) {
    return String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е');
  }

  private async syncCustomerTransactions(client: AmoClient, customerId: string, customerExternalId: string) {
    const transactions = await client.paginate<any>(`/customers/${customerExternalId}/transactions`, 'transactions');
    for (const transaction of transactions) {
      await this.prisma.customerTransaction.upsert({
        where: { externalId: String(transaction.id) },
        create: {
          externalId: String(transaction.id),
          customerId,
          amount: Number(transaction.price ?? transaction.amount ?? 0),
          comment: transaction.comment ?? null,
          raw: transaction,
          createdAt: toDateFromAmoTimestamp(transaction.created_at) ?? new Date(),
        },
        update: {
          customerId,
          amount: Number(transaction.price ?? transaction.amount ?? 0),
          comment: transaction.comment ?? null,
          raw: transaction,
        },
      });
    }
    return transactions.length;
  }

  private async syncEntityLinks(client: AmoClient, stats: Record<string, number>) {
    const sources: Array<{ entityType: 'LEAD' | 'CONTACT' | 'COMPANY' | 'CUSTOMER'; path: string; key: string }> = [
      { entityType: 'LEAD', path: '/leads/links', key: 'links' },
      { entityType: 'CONTACT', path: '/contacts/links', key: 'links' },
      { entityType: 'COMPANY', path: '/companies/links', key: 'links' },
      { entityType: 'CUSTOMER', path: '/customers/links', key: 'links' },
    ];

    let count = 0;
    for (const source of sources) {
      await this.syncOptional(`${source.entityType.toLowerCase()}Links`, stats, async () => {
        const links = await client.paginate<any>(source.path, source.key);
        for (const link of links) {
          const entityExternalId = this.extractLinkEntityId(link);
          const linkedEntityExternalId = this.extractLinkedEntityId(link);
          const linkedEntityType = this.extractLinkedEntityType(link);
          if (!entityExternalId || !linkedEntityExternalId || !linkedEntityType) continue;

          await this.prisma.entityLink.upsert({
            where: {
              entityType_entityExternalId_linkedEntityType_linkedEntityExternalId: {
                entityType: source.entityType,
                entityExternalId,
                linkedEntityType,
                linkedEntityExternalId,
              },
            },
            create: {
              entityType: source.entityType,
              entityExternalId,
              linkedEntityType,
              linkedEntityExternalId,
              metadata: link.metadata ?? {},
              raw: link,
            },
            update: {
              metadata: link.metadata ?? {},
              raw: link,
            },
          });
          count += 1;
        }
      });
    }
    stats.entityLinks = count;
  }

  private async upsertDeal(lead: any, maps: AmoSyncMaps) {
    const pipelineId = maps.pipelines.get(String(lead.pipeline_id));
    const stageId = maps.stages.get(`${lead.pipeline_id}_${lead.status_id}`);
    if (!pipelineId || !stageId) return;

    const stage = await this.prisma.pipelineStage.findUnique({ where: { id: stageId } });
    const contactExternalId = lead._embedded?.contacts?.[0]?.id ? String(lead._embedded.contacts[0].id) : null;
    const contactId = contactExternalId ? maps.contacts.get(contactExternalId) ?? null : null;
    const responsibleId = lead.responsible_user_id ? maps.users.get(String(lead.responsible_user_id)) ?? null : null;
    const lossReasonId = lead.loss_reason_id ? maps.lossReasons.get(`${lead.pipeline_id}_${lead.loss_reason_id}`) ?? null : null;
    const closedAt =
      toDateFromAmoTimestamp(lead.closed_at) ??
      (stage?.isWon ? toDateFromAmoTimestamp(lead.updated_at) : null);

    const existing = await this.prisma.deal.findUnique({
      where: { externalId: String(lead.id) },
      select: { id: true, stageId: true, responsibleId: true },
    });

    const data = {
      pipelineId,
      stageId,
      responsibleId,
      contactId,
      lossReasonId,
      title: lead.name || `Сделка ${lead.id}`,
      amount: Number(lead.price ?? 0),
      currency: 'RUB',
      source: this.extractSource(lead),
      tags: (lead._embedded?.tags ?? []).map((tag: any) => tag.name).filter(Boolean),
      customFields: this.parseCustomFields(lead.custom_fields_values),
      raw: lead,
      closedAt,
      expectedCloseAt: toDateFromAmoTimestamp(lead.closest_task_at),
      createdAt: toDateFromAmoTimestamp(lead.created_at) ?? new Date(),
      updatedAt: toDateFromAmoTimestamp(lead.updated_at) ?? new Date(),
    };

    const deal = existing
      ? await this.prisma.deal.update({ where: { id: existing.id }, data })
      : await this.prisma.deal.create({ data: { externalId: String(lead.id), ...data } });

    if (!existing) {
      await this.createStageHistoryIfMissing(deal.id, null, stageId, data.createdAt, 'initial_sync', lead);
    } else {
      if (existing.stageId !== stageId) {
        await this.createStageHistoryIfMissing(
          existing.id,
          existing.stageId,
          stageId,
          toDateFromAmoTimestamp(lead.updated_at) ?? new Date(),
          'sync',
          lead,
        );
      }
      if (existing.responsibleId !== responsibleId) {
        await this.prisma.dealResponsibleHistory.create({
          data: {
            dealId: existing.id,
            fromUserId: existing.responsibleId,
            toUserId: responsibleId,
            changedAt: toDateFromAmoTimestamp(lead.updated_at) ?? new Date(),
            raw: lead,
          },
        }).catch(() => undefined);
      }
    }

    await this.syncDealProducts(deal.id, lead);
  }

  private async syncTasks(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    const tasks = await client.paginate<any>('/tasks', 'tasks', params);
    for (const task of tasks) {
      let dealId: string | null = null;
      if (task.entity_type === 'leads' && task.entity_id) {
        const deal = await this.prisma.deal.findUnique({
          where: { externalId: String(task.entity_id) },
          select: { id: true },
        });
        dealId = deal?.id ?? null;
      }
      await this.prisma.task.upsert({
        where: { externalId: String(task.id) },
        create: {
          externalId: String(task.id),
          dealId,
          responsibleId: task.responsible_user_id ? maps.users.get(String(task.responsible_user_id)) ?? null : null,
          title: task.text || `Задача ${task.id}`,
          typeId: task.task_type_id ?? null,
          typeName: task.task_type ?? null,
          dueAt: toDateFromAmoTimestamp(task.complete_till),
          completedAt: task.is_completed ? toDateFromAmoTimestamp(task.updated_at) ?? new Date() : null,
          isCompleted: Boolean(task.is_completed),
          createdAt: toDateFromAmoTimestamp(task.created_at) ?? new Date(),
          updatedAt: toDateFromAmoTimestamp(task.updated_at) ?? new Date(),
          raw: task,
        },
        update: {
          dealId,
          responsibleId: task.responsible_user_id ? maps.users.get(String(task.responsible_user_id)) ?? null : null,
          title: task.text || `Задача ${task.id}`,
          typeId: task.task_type_id ?? null,
          typeName: task.task_type ?? null,
          dueAt: toDateFromAmoTimestamp(task.complete_till),
          completedAt: task.is_completed ? toDateFromAmoTimestamp(task.updated_at) ?? new Date() : null,
          isCompleted: Boolean(task.is_completed),
          createdAt: toDateFromAmoTimestamp(task.created_at) ?? undefined,
          updatedAt: toDateFromAmoTimestamp(task.updated_at) ?? undefined,
          raw: task,
        },
      });
    }
    stats.tasks = tasks.length;
  }

  private async syncNotes(client: AmoClient, stats: Record<string, number>, updatedSince?: number) {
    const params: Record<string, string | number> = {};
    if (updatedSince) params['filter[updated_at][from]'] = updatedSince;

    const notes = await client.paginate<any>('/leads/notes', 'notes', params);
    for (const note of notes) {
      const deal = note.entity_id
        ? await this.prisma.deal.findUnique({ where: { externalId: String(note.entity_id) }, select: { id: true } })
        : null;
      await this.prisma.note.upsert({
        where: { externalId: String(note.id) },
        create: {
          externalId: String(note.id),
          dealId: deal?.id ?? null,
          type: note.note_type ?? 'unknown',
          text: note.params?.text ?? null,
          createdAt: toDateFromAmoTimestamp(note.created_at) ?? new Date(),
          raw: note,
        },
        update: {
          dealId: deal?.id ?? null,
          type: note.note_type ?? 'unknown',
          text: note.params?.text ?? null,
          raw: note,
        },
      });
    }
    stats.notes = notes.length;
  }

  private async syncEvents(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params: Record<string, string | number> = {};
    if (updatedSince) params['filter[created_at][from]'] = updatedSince;

    const eventsById = new Map<string, any>();
    const addEvents = (events: any[]) => {
      for (const event of events) eventsById.set(String(event.id), event);
    };
    addEvents(await client.paginate<any>('/events', 'events', params));
    for (const type of this.extraEventTypes()) {
      addEvents(await client.paginate<any>('/events', 'events', { ...params, 'filter[type]': type }));
    }

    const events = [...eventsById.values()];
    for (const event of events) {
      const dealExternalId = this.getEventDealExternalId(event);
      const deal = dealExternalId
        ? await this.prisma.deal.findUnique({ where: { externalId: dealExternalId }, select: { id: true } })
        : null;
      await this.prisma.crmEvent.upsert({
        where: { externalId: String(event.id) },
        create: {
          externalId: String(event.id),
          dealId: deal?.id ?? null,
          type: event.type ?? 'unknown',
          valueBefore: event.value_before ?? undefined,
          valueAfter: event.value_after ?? undefined,
          createdAt: toDateFromAmoTimestamp(event.created_at) ?? new Date(),
          raw: event,
        },
        update: {
          dealId: deal?.id ?? null,
          type: event.type ?? 'unknown',
          valueBefore: event.value_before ?? undefined,
          valueAfter: event.value_after ?? undefined,
          raw: event,
        },
      });
      if (deal?.id) {
        await this.applyEventToStageHistory(event, deal.id, maps);
      }
    }
    stats.events = events.length;
    await this.backfillStageHistoryFromStoredEvents(maps, stats, updatedSince);
  }

  private extraEventTypes() {
    const configured = this.config.get<string>('AMOCRM_EXTRA_EVENT_TYPES');
    const eventTypes = new Set(['custom_field_809047_value_changed']);
    for (const type of configured?.split(',') ?? []) {
      const clean = type.trim();
      if (clean) eventTypes.add(clean);
    }
    return [...eventTypes];
  }

  private async backfillStageHistoryFromStoredEvents(
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const where: Record<string, any> = {
      type: 'lead_status_changed',
      dealId: { not: null },
    };
    if (updatedSince) {
      where.createdAt = { gte: new Date(updatedSince * 1000) };
    }

    const events = await this.prisma.crmEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        externalId: true,
        dealId: true,
        valueBefore: true,
        valueAfter: true,
        createdAt: true,
        raw: true,
      },
    });

    for (const event of events) {
      if (!event.dealId) continue;
      await this.applyEventToStageHistory(
        {
          ...(event.raw as Record<string, any>),
          id: event.externalId,
          value_before: event.valueBefore,
          value_after: event.valueAfter,
          created_at: Math.floor(event.createdAt.getTime() / 1000),
        },
        event.dealId,
        maps,
      );
    }
    stats.stageHistoryBackfilled = events.length;
  }

  private async applyEventToStageHistory(event: any, dealId: string, maps: AmoSyncMaps) {
    const after = this.extractStatusFromEvent(event.value_after);
    if (!after?.statusId || !after?.pipelineId) return;

    const before = this.extractStatusFromEvent(event.value_before);
    const toStageId = maps.stages.get(`${after.pipelineId}_${after.statusId}`);
    const fromStageId = before?.statusId && before.pipelineId
      ? maps.stages.get(`${before.pipelineId}_${before.statusId}`) ?? null
      : null;
    if (!toStageId) return;
    if (fromStageId && fromStageId === toStageId) return;

    await this.createStageHistoryIfMissing(
      dealId,
      fromStageId,
      toStageId,
      toDateFromAmoTimestamp(event.created_at) ?? new Date(),
      'crm_event',
      event,
    );
  }

  private extractStatusFromEvent(value: any): { pipelineId?: string; statusId?: string } | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const status = raw?.lead_status ?? raw?.status ?? raw;
    const statusId = status?.id ?? status?.status_id;
    const pipelineId = status?.pipeline_id ?? status?.pipeline?.id;
    if (!statusId) return null;
    return { statusId: String(statusId), pipelineId: pipelineId ? String(pipelineId) : undefined };
  }

  private async createStageHistoryIfMissing(
    dealId: string,
    fromStageId: string | null,
    toStageId: string,
    movedAt: Date,
    source: string,
    raw: any,
  ) {
    const existing = await this.prisma.dealStageHistory.findFirst({
      where: { dealId, fromStageId, toStageId, movedAt },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.dealStageHistory.create({
      data: {
        dealId,
        fromStageId,
        toStageId,
        movedAt,
        source,
        raw,
      },
    });
  }

  private async syncDealProducts(dealId: string, lead: any) {
    const catalogElements = lead._embedded?.catalog_elements ?? [];
    await this.prisma.dealProduct.deleteMany({ where: { dealId } });
    if (!Array.isArray(catalogElements) || catalogElements.length === 0) return;

    await this.prisma.dealProduct.createMany({
      data: catalogElements.map((item: any) => ({
        dealId,
        externalId: item.id ? String(item.id) : null,
        name: item.metadata?.catalog_element_name ?? item.name ?? 'Товар',
        sku: item.metadata?.sku ?? null,
        quantity: Number(item.metadata?.quantity ?? 1),
        price: Number(item.metadata?.unit_price ?? item.metadata?.price ?? 0),
        raw: item,
      })),
    });
  }

  private async recalculateStageProbabilities() {
    const stages = await this.prisma.pipelineStage.findMany({
      where: { isWon: false, isLost: false },
      include: { pipeline: true },
    });
    const wonStages = await this.prisma.pipelineStage.findMany({
      where: { isWon: true },
      select: { id: true },
    });
    const wonStageIds = new Set(wonStages.map((stage) => stage.id));

    for (const stage of stages) {
      const dealIdsInStage = await this.prisma.dealStageHistory.findMany({
        where: {
          toStageId: stage.id,
          NOT: [{ fromStageId: stage.id }],
        },
        distinct: ['dealId'],
        select: { dealId: true },
      });
      const sampleSize = dealIdsInStage.length;
      let wonCount = 0;
      if (sampleSize > 0) {
        wonCount = await this.prisma.dealStageHistory.count({
          where: {
            dealId: { in: dealIdsInStage.map((item) => item.dealId) },
            toStageId: { in: [...wonStageIds] },
            NOT: [{ fromStageId: { in: [...wonStageIds] } }],
          },
        });
      }

      const autoPercent = sampleSize <= 2 ? 0 : (wonCount / sampleSize) * 100;
      const confidence = sampleSize <= 2 ? 0 : Math.min(1, sampleSize / 30);

      await this.prisma.stageProbability.upsert({
        where: { stageId: stage.id },
        create: { stageId: stage.id, autoPercent, sampleSize, confidence },
        update: { autoPercent, sampleSize, confidence },
      });
    }
  }

  private parseCustomFields(fields: any[] | null | undefined): Record<string, any> {
    const result: Record<string, any> = {};
    for (const field of fields ?? []) {
      const key = String(field.field_id);
      const values = (field.values ?? []).map((value: any) => value.value ?? value.enum_id ?? null);
      result[key] = {
        name: field.field_name,
        code: field.field_code,
        values,
        value: values.length <= 1 ? values[0] ?? null : values,
      };
    }
    return result;
  }

  private findFieldValue(fields: any[] | null | undefined, code: string): string | null {
    const field = (fields ?? []).find((item) => item.field_code === code || item.field_name === code);
    return field?.values?.[0]?.value ?? null;
  }

  private extractSource(lead: any): string | null {
    const fields = this.parseCustomFields(lead.custom_fields_values);
    for (const field of Object.values(fields)) {
      if (typeof field === 'object' && (field as any).code === 'SOURCE_ID') {
        return String((field as any).value ?? '') || null;
      }
    }
    return null;
  }

  private getEventDealExternalId(event: any): string | null {
    const entityId = event.entity_id ?? event.entity?.id;
    const entityType = event.entity_type ?? event.entity;
    if (!entityId) return null;
    if (String(entityType).includes('lead')) return String(entityId);
    return null;
  }

  private extractLinkEntityId(link: any): string | null {
    const value = link.entity_id ?? link.from_entity_id ?? link.from_entity?.id ?? link._embedded?.entity?.id;
    return value === null || value === undefined ? null : String(value);
  }

  private extractLinkedEntityId(link: any): string | null {
    const value = link.to_entity_id ?? link.linked_entity_id ?? link.to_entity?.id ?? link._embedded?.to_entity?.id;
    return value === null || value === undefined ? null : String(value);
  }

  private extractLinkedEntityType(link: any): string | null {
    const value = link.to_entity_type ?? link.linked_entity_type ?? link.to_entity?.type ?? link._embedded?.to_entity?.type;
    return value === null || value === undefined ? null : String(value);
  }
}
