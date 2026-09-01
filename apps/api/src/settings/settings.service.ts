import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateForecastSettingsDto } from './dto/update-forecast-settings.dto';
import { UpdateRopStageSlaDto } from './dto/update-rop-stage-sla.dto';
import { UpdateStageProbabilityDto } from './dto/update-stage-probability.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';
import { AuditService } from '../audit/audit.service';
import {
  isRealAmoExternalId,
  ROP_DEPARTMENTS,
  resolveDefaultRopStageSla,
  ropDepartmentKeyFromInput,
  RopDepartmentKey,
} from '../platform/rop-stage-sla';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getOptions() {
    const [
      pipelines,
      managers,
      groups,
      customFields,
      tags,
      catalogs,
      sources,
      customerStatuses,
      customerSegments,
      roles,
      appUsers,
      taskTypeRows,
    ] = await Promise.all([
      this.prisma.pipeline.findMany({
        orderBy: { name: 'asc' },
        include: { stages: { orderBy: { position: 'asc' } } },
      }),
      this.prisma.crmUser.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        include: { group: true },
      }),
      this.prisma.crmGroup.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.customFieldDefinition.findMany({ orderBy: [{ entityType: 'asc' }, { name: 'asc' }] }),
      this.prisma.crmTag.findMany({ orderBy: [{ entityType: 'asc' }, { name: 'asc' }] }),
      this.prisma.catalog.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
      this.prisma.crmSource.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.customerStatus.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
      this.prisma.customerSegment.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.crmRole.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, email: true, name: true, role: true, businessRole: true, crmUserId: true },
      }),
      this.prisma.task.findMany({
        where: { typeId: { not: null } },
        distinct: ['typeId'],
        orderBy: { typeId: 'asc' },
        select: { typeId: true, typeName: true },
      }),
    ]);
    const taskTypes = taskTypeRows.map((item) => ({
      id: String(item.typeId),
      name: item.typeName || `Тип ${item.typeId}`,
    }));

    return {
      pipelines,
      managers,
      groups,
      customFields,
      tags,
      catalogs,
      sources,
      customerStatuses,
      customerSegments,
      roles,
      appUsers,
      taskTypes,
    };
  }

  async getForecastSettings() {
    const settings = await this.ensureForecastSettings();
    const probabilities = await this.prisma.stageProbability.findMany({
      include: { stage: { include: { pipeline: true } } },
      orderBy: { stage: { position: 'asc' } },
    });
    return { settings, probabilities };
  }

  async getRopStageSlaSettings() {
    const scope = await this.ropStageSlaScope();
    if (scope.keys.length === 0) {
      return { generatedAt: new Date().toISOString(), departments: [] };
    }
    const existingRules = await this.prisma.ropStageSlaRule.findMany({
      where: {
        OR: [...scope.keys].map((key) => ({ departmentKey: key.departmentKey, stageId: key.stageId })),
      },
      include: { stage: { include: { pipeline: true } } },
    });
    const existingKeys = new Set(existingRules.map((rule) => this.ropStageSlaKey(rule.departmentKey, rule.stageId)));
    const missing = scope.rows.filter((row) => !existingKeys.has(this.ropStageSlaKey(row.departmentKey, row.stageId)));

    if (missing.length > 0) {
      await this.prisma.$transaction(
        missing.map((row) => {
          const fallback = resolveDefaultRopStageSla(row.departmentKey, row.pipelineName, row.stageName);
          return this.prisma.ropStageSlaRule.create({
            data: {
              departmentKey: row.departmentKey,
              stageId: row.stageId,
              isEnabled: fallback.days !== null,
              slaDays: fallback.days,
              reason: fallback.reason,
            },
          });
        }),
      );
    }

    const rules = missing.length > 0
      ? await this.prisma.ropStageSlaRule.findMany({
        where: {
          OR: [...scope.keys].map((key) => ({ departmentKey: key.departmentKey, stageId: key.stageId })),
        },
        include: { stage: { include: { pipeline: true } } },
      })
      : existingRules;
    const ruleByKey = new Map(rules.map((rule) => [this.ropStageSlaKey(rule.departmentKey, rule.stageId), rule]));

    return {
      generatedAt: new Date().toISOString(),
      departments: ROP_DEPARTMENTS.map((department) => {
        const rows = scope.rows.filter((row) => row.departmentKey === department.key);
        const pipelines = [...new Map(rows.map((row) => [row.pipelineId, {
          id: row.pipelineId,
          name: row.pipelineName,
        }])).values()]
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
          .map((pipeline) => ({
            ...pipeline,
            stages: rows
              .filter((row) => row.pipelineId === pipeline.id)
              .sort((a, b) => a.stagePosition - b.stagePosition)
              .map((row) => {
                const rule = ruleByKey.get(this.ropStageSlaKey(row.departmentKey, row.stageId));
                const fallback = resolveDefaultRopStageSla(row.departmentKey, row.pipelineName, row.stageName);
                return {
                  departmentKey: row.departmentKey,
                  stageId: row.stageId,
                  stageName: row.stageName,
                  stagePosition: row.stagePosition,
                  pipelineId: row.pipelineId,
                  pipelineName: row.pipelineName,
                  openDeals: row.openDeals,
                  ruleId: rule?.id ?? null,
                  isEnabled: rule?.isEnabled ?? fallback.days !== null,
                  slaDays: rule?.slaDays ?? fallback.days,
                  reason: rule?.reason ?? fallback.reason,
                };
              }),
          }));
        return {
          key: department.key,
          label: department.label,
          pipelines,
        };
      }).filter((department) => department.pipelines.length > 0),
    };
  }

  async updateRopStageSla(dto: UpdateRopStageSlaDto, actorUserId?: string) {
    const departmentKey = ropDepartmentKeyFromInput(dto.departmentKey);
    if (!departmentKey) throw new BadRequestException('Неизвестный отдел');
    if (dto.isEnabled && !dto.slaDays) throw new BadRequestException('Укажи SLA в днях');

    const stage = await this.prisma.pipelineStage.findUnique({
      where: { id: dto.stageId },
      include: { pipeline: true },
    });
    if (!stage) throw new BadRequestException('Этап не найден');

    const reason = dto.reason?.trim() || null;
    const rule = await this.prisma.ropStageSlaRule.upsert({
      where: { departmentKey_stageId: { departmentKey, stageId: dto.stageId } },
      create: {
        departmentKey,
        stageId: dto.stageId,
        isEnabled: dto.isEnabled,
        slaDays: dto.isEnabled ? dto.slaDays! : null,
        reason,
      },
      update: {
        isEnabled: dto.isEnabled,
        slaDays: dto.isEnabled ? dto.slaDays! : null,
        reason,
      },
    });
    await this.audit.record({
      userId: actorUserId,
      action: 'settings.rop_stage_sla.update',
      entity: 'RopStageSlaRule',
      entityId: rule.id,
      metadata: {
        departmentKey,
        stageId: dto.stageId,
        stageName: stage.name,
        pipelineName: stage.pipeline.name,
        isEnabled: dto.isEnabled,
        slaDays: rule.slaDays,
      },
    });
    return rule;
  }

  async updateForecastSettings(dto: UpdateForecastSettingsDto, actorUserId?: string) {
    const settings = await this.ensureForecastSettings();
    const updated = await this.prisma.forecastSettings.update({
      where: { id: settings.id },
      data: {
        closingStageId: dto.closingStageId ?? settings.closingStageId,
        shippingPipelineId: dto.shippingPipelineId ?? settings.shippingPipelineId,
        shippingSuccessStageId: dto.shippingSuccessStageId ?? settings.shippingSuccessStageId,
        probabilityMode: dto.probabilityMode ?? settings.probabilityMode,
        minSampleSize: dto.minSampleSize ?? settings.minSampleSize,
      },
    });
    await this.audit.record({
      userId: actorUserId,
      action: 'settings.forecast.update',
      entity: 'ForecastSettings',
      entityId: updated.id,
      metadata: { ...dto },
    });
    return updated;
  }

  async updateStageProbability(dto: UpdateStageProbabilityDto, actorUserId?: string) {
    const probability = await this.prisma.stageProbability.upsert({
      where: { stageId: dto.stageId },
      create: {
        stageId: dto.stageId,
        manualPercent: dto.manualPercent ?? null,
      },
      update: {
        manualPercent: dto.manualPercent ?? null,
      },
    });
    await this.audit.record({
      userId: actorUserId,
      action: 'settings.stage_probability.update',
      entity: 'StageProbability',
      entityId: probability.id,
      metadata: { ...dto },
    });
    return probability;
  }

  async updateVisibility(dto: UpdateVisibilityDto, actorUserId?: string) {
    await this.prisma.$transaction([
      ...dto.managers.map((item) =>
        this.prisma.crmUser.update({ where: { id: item.id }, data: { isVisible: item.isVisible } }),
      ),
      ...dto.groups.map((item) =>
        this.prisma.crmGroup.update({ where: { id: item.id }, data: { isVisible: item.isVisible } }),
      ),
    ]);
    await this.audit.record({
      userId: actorUserId,
      action: 'settings.visibility.update',
      entity: 'CrmVisibility',
      metadata: {
        managers: dto.managers.length,
        groups: dto.groups.length,
      },
    });
    return this.getOptions();
  }

  async getDashboardLayout(userId: string) {
    const existing = await this.prisma.dashboardLayout.findFirst({ where: { userId, isDefault: true } });
    return existing ?? { config: {} };
  }

  async saveDashboardLayout(userId: string, config: Record<string, unknown>) {
    const existing = await this.prisma.dashboardLayout.findFirst({ where: { userId, isDefault: true } });
    if (existing) {
      const layout = await this.prisma.dashboardLayout.update({
        where: { id: existing.id },
        data: { config: config as Prisma.InputJsonValue },
      });
      await this.audit.record({
        userId,
        action: 'settings.dashboard_layout.update',
        entity: 'DashboardLayout',
        entityId: layout.id,
      });
      return layout;
    }
    const layout = await this.prisma.dashboardLayout.create({
      data: {
        userId,
        name: 'Рабочий стол РОПа',
        isDefault: true,
        config: config as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      userId,
      action: 'settings.dashboard_layout.create',
      entity: 'DashboardLayout',
      entityId: layout.id,
    });
    return layout;
  }
  private async ensureForecastSettings() {
    const existing = await this.prisma.forecastSettings.findFirst();
    if (existing) return existing;
    return this.prisma.forecastSettings.create({ data: {} });
  }

  private async ropStageSlaScope() {
    const crmUsers = await this.prisma.crmUser.findMany({
      where: { isActive: true, isVisible: true },
      select: {
        id: true,
        externalId: true,
        group: { select: { externalId: true, name: true } },
      },
    });
    const managerDepartments = new Map<string, RopDepartmentKey>();
    for (const user of crmUsers) {
      const departmentKey = ropDepartmentKeyFromInput(user.group?.name);
      if (!departmentKey || !isRealAmoExternalId(user.externalId) || !isRealAmoExternalId(user.group?.externalId)) continue;
      managerDepartments.set(user.id, departmentKey);
    }
    const deals = managerDepartments.size > 0
      ? await this.prisma.deal.findMany({
        where: {
          deletedAt: null,
          responsibleId: { in: [...managerDepartments.keys()] },
          pipeline: { isArchived: false },
          stage: { isWon: false, isLost: false, isVisible: true },
        },
        select: {
          responsibleId: true,
          pipeline: { select: { id: true, name: true } },
          stage: { select: { id: true, name: true, position: true } },
        },
      })
      : [];

    const rowByKey = new Map<string, {
      departmentKey: RopDepartmentKey;
      pipelineId: string;
      pipelineName: string;
      stageId: string;
      stageName: string;
      stagePosition: number;
      openDeals: number;
    }>();
    for (const deal of deals) {
      const departmentKey = deal.responsibleId ? managerDepartments.get(deal.responsibleId) : null;
      if (!departmentKey) continue;
      const key = this.ropStageSlaKey(departmentKey, deal.stage.id);
      const row = rowByKey.get(key) ?? {
        departmentKey,
        pipelineId: deal.pipeline.id,
        pipelineName: deal.pipeline.name,
        stageId: deal.stage.id,
        stageName: deal.stage.name,
        stagePosition: deal.stage.position,
        openDeals: 0,
      };
      row.openDeals += 1;
      rowByKey.set(key, row);
    }

    const rows = [...rowByKey.values()].sort(
      (a, b) =>
        a.departmentKey.localeCompare(b.departmentKey, 'ru') ||
        a.pipelineName.localeCompare(b.pipelineName, 'ru') ||
        a.stagePosition - b.stagePosition,
    );
    return {
      rows,
      keys: rows.map((row) => ({ departmentKey: row.departmentKey, stageId: row.stageId })),
    };
  }

  private ropStageSlaKey(departmentKey: string, stageId: string) {
    return `${departmentKey}:${stageId}`;
  }
}
