import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateForecastSettingsDto } from './dto/update-forecast-settings.dto';
import { UpdateStageProbabilityDto } from './dto/update-stage-probability.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getOptions() {
    const [pipelines, managers, groups, customFields] = await Promise.all([
      this.prisma.pipeline.findMany({
        orderBy: { name: 'asc' },
        include: { stages: { orderBy: { position: 'asc' } } },
      }),
      this.prisma.crmUser.findMany({ orderBy: { name: 'asc' }, include: { group: true } }),
      this.prisma.crmGroup.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.customFieldDefinition.findMany({ orderBy: [{ entityType: 'asc' }, { name: 'asc' }] }),
    ]);

    return { pipelines, managers, groups, customFields };
  }

  async getForecastSettings() {
    const settings = await this.ensureForecastSettings();
    const probabilities = await this.prisma.stageProbability.findMany({
      include: { stage: { include: { pipeline: true } } },
      orderBy: { stage: { position: 'asc' } },
    });
    return { settings, probabilities };
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
      return this.prisma.dashboardLayout.update({
        where: { id: existing.id },
        data: { config: config as Prisma.InputJsonValue },
      });
    }
    return this.prisma.dashboardLayout.create({
      data: {
        userId,
        name: 'Рабочий стол РОПа',
        isDefault: true,
        config: config as Prisma.InputJsonValue,
      },
    });
  }

  private async ensureForecastSettings() {
    const existing = await this.prisma.forecastSettings.findFirst();
    if (existing) return existing;
    return this.prisma.forecastSettings.create({ data: {} });
  }
}
