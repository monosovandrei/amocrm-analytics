import { Injectable, Logger } from '@nestjs/common';
import { SyncJobType } from '../generated/prisma';
import { toDateFromAmoTimestamp } from '../common/date.util';
import { PrismaService } from '../prisma/prisma.service';
import { AmoClient } from './amo-client';
import { AmoService } from './amo.service';
import { AmoSyncMaps } from './amo.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AmoSyncService {
  private readonly logger = new Logger(AmoSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly amo: AmoService,
    private readonly audit: AuditService,
  ) {}

  async trigger(type: SyncJobType, actorUserId?: string) {
    const connection = await this.amo.getActiveConnectionOrFail();
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
      const updatedSince = this.getUpdatedSince(job.type, job.connection.lastIncrementalSyncAt);

      const maps = await this.syncMetadata(client, stats);
      await this.syncCustomFieldDefinitions(client, stats);
      await this.syncCompanies(client, maps, stats, updatedSince);
      await this.syncContacts(client, maps, stats, updatedSince);
      await this.syncDeals(client, maps, stats, updatedSince);
      await this.syncTasks(client, maps, stats, updatedSince);
      await this.syncNotes(client, stats, updatedSince);
      await this.syncEvents(client, maps, stats, updatedSince);
      await this.recalculateStageProbabilities();

      const now = new Date();
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'SUCCESS', finishedAt: now, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: {
          status: 'ACTIVE',
          lastError: null,
          lastFullSyncAt: job.type === 'FULL' ? now : job.connection.lastFullSyncAt,
          lastIncrementalSyncAt: now,
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
    };
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
        const dbStage = await this.prisma.pipelineStage.upsert({
          where: {
            pipelineId_externalId: {
              pipelineId: dbPipeline.id,
              externalId: String(status.id),
            },
          },
          create: {
            pipelineId: dbPipeline.id,
            externalId: String(status.id),
            name: status.name,
            position: Number(status.sort ?? 0),
            color: status.color ?? null,
            isWon: status.type === 'win',
            isLost: status.type === 'loss',
            raw: status,
          },
          update: {
            name: status.name,
            position: Number(status.sort ?? 0),
            color: status.color ?? null,
            isWon: status.type === 'win',
            isLost: status.type === 'loss',
            raw: status,
          },
        });
        maps.stages.set(`${pipeline.id}_${status.id}`, dbStage.id);
      }

      await this.syncLossReasons(client, dbPipeline.id, String(pipeline.id), maps);
    }

    const users = await client.paginate<any>('/users', 'users');
    for (const user of users) {
      const groupExternalId = user.rights?.group_id ? String(user.rights.group_id) : null;
      let groupId: string | null = null;
      if (groupExternalId) {
        const group = await this.prisma.crmGroup.upsert({
          where: { externalId: groupExternalId },
          create: { externalId: groupExternalId, name: user.rights?.group_name ?? `Группа ${groupExternalId}`, raw: user.rights ?? {} },
          update: { name: user.rights?.group_name ?? `Группа ${groupExternalId}`, raw: user.rights ?? {} },
        });
        groupId = group.id;
      }

      const dbUser = await this.prisma.crmUser.upsert({
        where: { externalId: String(user.id) },
        create: {
          externalId: String(user.id),
          groupId,
          name: user.name || user.email || `Менеджер ${user.id}`,
          email: user.email ?? null,
          isActive: !user.is_free,
          raw: user,
        },
        update: {
          groupId,
          name: user.name || user.email || `Менеджер ${user.id}`,
          email: user.email ?? null,
          isActive: !user.is_free,
          raw: user,
        },
      });
      maps.users.set(String(user.id), dbUser.id);
    }

    stats.pipelines = maps.pipelines.size;
    stats.stages = maps.stages.size;
    stats.users = maps.users.size;
    return maps;
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
    const sources: Array<{ entity: 'LEAD' | 'CONTACT' | 'COMPANY'; path: string; key: string }> = [
      { entity: 'LEAD', path: '/leads/custom_fields', key: 'custom_fields' },
      { entity: 'CONTACT', path: '/contacts/custom_fields', key: 'custom_fields' },
      { entity: 'COMPANY', path: '/companies/custom_fields', key: 'custom_fields' },
    ];

    let count = 0;
    for (const source of sources) {
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
        count += 1;
      }
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

    const events = await client.paginate<any>('/events', 'events', params);
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
}
