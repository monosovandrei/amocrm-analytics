import JSZip from 'jszip';
import { Injectable } from '@nestjs/common';
import { ReportSourceType, UserRole } from '../generated/prisma';
import { endOfMonth, median, startOfMonth } from '../common/date.util';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportQueryDto, SaveReportTemplateDto } from './dto/report-query.dto';
import {
  ConversionStep,
  DataContractConfig,
  DataContractDuration,
  DataContractMetric,
  ReportConfig,
  ReportFilters,
} from './report-types';

type XlsxValue = string | number | boolean | null | undefined;
type XlsxSheet = { name: string; rows: XlsxValue[][] };

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async compute(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    const filters = dto.filters as ReportFilters;
    const config = dto.config as ReportConfig;

    if (config.metric === 'forecast') {
      return this.computeForecast(filters);
    }
    if (config.contract?.metrics?.length) {
      return this.computeDataContract(filters, config.contract, user.role);
    }
    if (config.steps?.length) {
      return this.computeConversionReport(filters, config, user.role);
    }
    return this.computeCurrentSnapshot(filters, user.role);
  }

  async listTemplates() {
    return this.prisma.reportTemplate.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'desc' }] });
  }

  async saveTemplate(dto: SaveReportTemplateDto, userId: string) {
    const data = {
      userId,
      name: dto.name,
      sourceType: dto.sourceType as ReportSourceType,
      config: { filters: dto.filters, ...dto.config },
      position: Number(dto.config?.order ?? 0),
    };
    if (dto.id) {
      const template = await this.prisma.reportTemplate.update({ where: { id: dto.id }, data });
      await this.audit.record({
        userId,
        action: 'reports.template.update',
        entity: 'ReportTemplate',
        entityId: template.id,
        metadata: { name: template.name, sourceType: template.sourceType },
      });
      return template;
    }
    const template = await this.prisma.reportTemplate.create({ data });
    await this.audit.record({
      userId,
      action: 'reports.template.create',
      entity: 'ReportTemplate',
      entityId: template.id,
      metadata: { name: template.name, sourceType: template.sourceType },
    });
    return template;
  }

  async deleteTemplate(id: string, userId?: string) {
    await this.prisma.reportTemplate.delete({ where: { id } });
    await this.audit.record({
      userId,
      action: 'reports.template.delete',
      entity: 'ReportTemplate',
      entityId: id,
    });
    return { ok: true };
  }

  async exportExcel(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    const report = await this.compute(dto, user);
    const sheets: XlsxSheet[] = [
      {
        name: 'Параметры',
        rows: [
          ['Отчет', dto.name],
          ['Источник', dto.sourceType],
          ['Сформирован', new Date().toISOString()],
          ['Фильтры', JSON.stringify(dto.filters)],
        ],
      },
    ];

    if (Array.isArray((report as any).steps)) {
      sheets.push(this.jsonSheet('Конверсии', (report as any).steps));
    }
    if (Array.isArray((report as any).rows)) {
      sheets.push(this.jsonSheet('Данные', (report as any).rows));
    }
    if (Array.isArray((report as any).tableRows)) {
      sheets.push(this.jsonSheet('Data contract', (report as any).tableRows));
    }
    if ((report as any).forecast) {
      sheets.push(this.jsonSheet('Прогноз', [(report as any).forecast]));
    }

    return this.buildXlsx(sheets);
  }

  private jsonSheet(name: string, rows: Array<Record<string, any>>): XlsxSheet {
    if (rows.length === 0) return { name, rows: [] };

    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    return {
      name,
      rows: [columns, ...rows.map((row) => columns.map((key) => this.excelCellValue(row[key])))],
    };
  }

  private excelCellValue(value: unknown) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  }

  private async buildXlsx(sheets: XlsxSheet[]) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', this.contentTypesXml(sheets.length));
    zip.folder('_rels')!.file('.rels', this.rootRelsXml());
    zip.folder('xl')!.file('workbook.xml', this.workbookXml(sheets));
    zip.folder('xl')!.folder('_rels')!.file('workbook.xml.rels', this.workbookRelsXml(sheets.length));
    const worksheets = zip.folder('xl')!.folder('worksheets')!;
    sheets.forEach((sheet, index) => worksheets.file(`sheet${index + 1}.xml`, this.worksheetXml(sheet.rows)));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  private contentTypesXml(sheetCount: number) {
    const sheets = Array.from({ length: sheetCount }, (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets}
</Types>`;
  }

  private rootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  }

  private workbookXml(sheets: XlsxSheet[]) {
    const sheetItems = sheets
      .map((sheet, index) => `<sheet name="${this.xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetItems}</sheets>
</workbook>`;
  }

  private workbookRelsXml(sheetCount: number) {
    const rels = Array.from({ length: sheetCount }, (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  }

  private worksheetXml(rows: XlsxValue[][]) {
    const rowXml = rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, colIndex) => this.cellXml(value, `${this.columnName(colIndex + 1)}${rowIndex + 1}`))
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  }

  private cellXml(value: XlsxValue, ref: string) {
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${this.xmlText(String(value ?? ''))}</t></is></c>`;
  }

  private columnName(index: number) {
    let name = '';
    let current = index;
    while (current > 0) {
      const remainder = (current - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      current = Math.floor((current - 1) / 26);
    }
    return name;
  }

  private xmlText(value: string) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private xmlAttr(value: string) {
    return this.xmlText(value).replace(/"/g, '&quot;');
  }
  private async computeDataContract(filters: ReportFilters, contract: DataContractConfig, role: UserRole) {
    const groupBy = contract.groupBy ?? 'manager';
    const groups = new Map<string, { id: string; name: string }>();
    const metricResults = new Map<
      string,
      Map<string, { count: number; values: number[]; dealIds: Set<string>; value: number | null; unit: string }>
    >();
    groups.set('all', { id: 'all', name: 'РћС‚РґРµР»' });

    for (const metric of contract.metrics ?? []) {
      const byGroup = new Map<string, { count: number; values: number[]; dealIds: Set<string>; value: number | null; unit: string }>();
      byGroup.set('all', { count: 0, values: [], dealIds: new Set<string>(), value: null, unit: this.metricUnit(metric) });

      if (metric.type === 'conversion') {
        metricResults.set(metric.id, byGroup);
        continue;
      }

      const deals = await this.findDealsForContractMetric(metric, filters, role);

      for (const deal of deals) {
        const groupId = groupBy === 'manager' ? deal.responsibleId ?? 'unassigned' : 'all';
        const groupName = groupBy === 'manager' ? deal.responsible?.name ?? 'Р‘РµР· РјРµРЅРµРґР¶РµСЂР°' : 'РћС‚РґРµР»';
        groups.set(groupId, { id: groupId, name: groupName });
        this.addDealToContractBucket(byGroup.get('all')!, deal, metric);
        if (groupId !== 'all') {
          if (!byGroup.has(groupId)) {
            byGroup.set(groupId, { count: 0, values: [], dealIds: new Set<string>(), value: null, unit: this.metricUnit(metric) });
          }
          this.addDealToContractBucket(byGroup.get(groupId)!, deal, metric);
        }
      }

      for (const bucket of byGroup.values()) this.finalizeContractBucket(bucket, metric);
      metricResults.set(metric.id, byGroup);
    }

    const durationResults = await this.computeContractDurations(filters, contract.durations ?? [], role, groups);

    const rows = [...groups.values()].map((group) => {
      const metrics = Object.fromEntries(
        (contract.metrics ?? []).map((metric) => {
          const value = metricResults.get(metric.id)?.get(group.id) ?? {
            count: 0,
            dealIds: new Set<string>(),
            values: [],
            value: null,
            unit: this.metricUnit(metric),
          };

          if (metric.type === 'conversion') {
            const from = metricResults.get(metric.fromMetricId ?? '')?.get(group.id)?.count ?? 0;
            const to = metricResults.get(metric.toMetricId ?? '')?.get(group.id)?.count ?? 0;
            value.count = to;
            value.value = from > 0 ? Number(((to / from) * 100).toFixed(2)) : null;
            value.unit = 'percent';
          }

          return [
            metric.id,
            {
              id: metric.id,
              label: metric.label,
              value: value.value,
              unit: value.unit,
              dealCount: value.count,
            },
          ];
        }),
      );

      const conversions = Object.fromEntries(
        (contract.conversions ?? []).map((conversion) => {
          const from = metricResults.get(conversion.fromMetricId)?.get(group.id)?.count ?? 0;
          const to = metricResults.get(conversion.toMetricId)?.get(group.id)?.count ?? 0;
          return [
            conversion.id,
            {
              id: conversion.id,
              label: conversion.label,
              from,
              to,
              conversion: from > 0 ? Number(((to / from) * 100).toFixed(2)) : null,
            },
          ];
        }),
      );

      const durations = Object.fromEntries(
        (contract.durations ?? []).map((duration) => [
          duration.id,
          durationResults.get(duration.id)?.get(group.id) ?? {
            id: duration.id,
            label: duration.label,
            avgDays: null,
            sampleSize: 0,
          },
        ]),
      );

      return { groupId: group.id, groupName: group.name, metrics, conversions, durations };
    });

    return {
      type: 'contract',
      groupBy,
      metrics: contract.metrics ?? [],
      conversions: contract.conversions ?? [],
      durations: contract.durations ?? [],
      rows,
      tableRows: this.flattenContractRows(rows, contract),
    };
  }

  private async findDealsForContractMetric(metric: DataContractMetric, filters: ReportFilters, role: UserRole) {
    const scopedFilters: ReportFilters = {
      ...filters,
      pipelineIds: metric.pipelineId ? [metric.pipelineId] : filters.pipelineIds,
    };

    if (metric.type === 'stage_reached') {
      const stageIds = metric.stageIds?.filter(Boolean) ?? [];
      if (stageIds.length === 0) return [];
      const dealIds = await this.findDealIdsFromHistoryMany(stageIds, scopedFilters, role, metric.fromStageId);
      return this.findDealsByIds(dealIds);
    }

    if (metric.type === 'current_stage') {
      const stageIds = metric.stageIds?.filter(Boolean) ?? [];
      if (stageIds.length === 0) return [];
      return this.findFilteredDeals({ ...scopedFilters, stageIds }, role);
    }

    if (metric.type === 'field_condition' && metric.fieldId) {
      return this.findFilteredDeals(
        {
          ...scopedFilters,
          customFields: [
            {
              fieldId: metric.fieldId,
              operator: metric.fieldOperator ?? 'equals',
              value: metric.fieldValue,
            },
          ],
        },
        role,
        { createdAt: this.dateRange(filters) },
      );
    }

    return this.findFilteredDeals(scopedFilters, role, { createdAt: this.dateRange(filters) });
  }

  private addDealToContractBucket(
    bucket: { count: number; values: number[]; dealIds: Set<string>; value: number | null; unit: string },
    deal: any,
    metric: DataContractMetric,
  ) {
    if (bucket.dealIds.has(deal.id)) return;
    bucket.dealIds.add(deal.id);
    bucket.count += 1;
    const measure = metric.measure ?? 'deal_count';
    if (measure === 'field_sum' || measure === 'field_avg') {
      const fieldId = metric.valueFieldId ?? metric.amountFieldId ?? metric.marginFieldId;
      const number = fieldId
        ? this.numericCustomField(deal.customFields as Record<string, any>, fieldId)
        : Number(deal.amount ?? 0);
      bucket.values.push(number);
    }
  }

  private finalizeContractBucket(
    bucket: { count: number; values: number[]; dealIds: Set<string>; value: number | null; unit: string },
    metric: DataContractMetric,
  ) {
    const measure = metric.measure ?? 'deal_count';
    if (measure === 'field_sum') {
      bucket.value = Math.round(bucket.values.reduce((sum, value) => sum + value, 0));
      return;
    }
    if (measure === 'field_avg') {
      bucket.value = bucket.values.length
        ? Number((bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length).toFixed(2))
        : null;
      return;
    }
    bucket.value = bucket.count;
  }

  private metricUnit(metric: DataContractMetric) {
    if (metric.type === 'conversion' || metric.display === 'percent') return 'percent';
    if (metric.display === 'money' || metric.measure === 'field_sum' || metric.measure === 'field_avg') return 'money';
    return 'number';
  }

  private async computeContractDurations(
    filters: ReportFilters,
    durations: DataContractDuration[],
    role: UserRole,
    groups: Map<string, { id: string; name: string }>,
  ) {
    const result = new Map<
      string,
      Map<string, { id: string; label: string; avgDays: number | null; sampleSize: number }>
    >();
    const stageIds = durations.map((item) => item.stageId).filter(Boolean);
    if (stageIds.length === 0) return result;

    const entries = await this.prisma.dealStageHistory.findMany({
      where: {
        toStageId: { in: stageIds },
        movedAt: this.dateRange(filters),
        NOT: [{ fromStageId: { in: stageIds } }],
        deal: await this.buildDealWhere(filters, role),
      },
      include: {
        deal: { include: { responsible: { include: { group: true } } } },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
    });

    const allHistory = entries.length
      ? await this.prisma.dealStageHistory.findMany({
          where: { dealId: { in: [...new Set(entries.map((entry) => entry.dealId))] } },
          orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
          select: { id: true, dealId: true, movedAt: true },
        })
      : [];
    const historiesByDeal = new Map<string, Array<{ id: string; movedAt: Date }>>();
    for (const item of allHistory) {
      if (!historiesByDeal.has(item.dealId)) historiesByDeal.set(item.dealId, []);
      historiesByDeal.get(item.dealId)!.push({ id: item.id, movedAt: item.movedAt });
    }

    for (const duration of durations) {
      const byGroupValues = new Map<string, number[]>();
      byGroupValues.set('all', []);

      for (const entry of entries.filter((item) => item.toStageId === duration.stageId)) {
        const history = historiesByDeal.get(entry.dealId) ?? [];
        const index = history.findIndex((item) => item.id === entry.id);
        const endAt = index >= 0 ? history[index + 1]?.movedAt ?? new Date() : new Date();
        if (endAt <= entry.movedAt) continue;
        const days = (endAt.getTime() - entry.movedAt.getTime()) / 86_400_000;
        const groupId = entry.deal.responsibleId ?? 'unassigned';
        const groupName = entry.deal.responsible?.name ?? 'Р‘РµР· РјРµРЅРµРґР¶РµСЂР°';
        groups.set(groupId, { id: groupId, name: groupName });
        byGroupValues.get('all')!.push(days);
        if (!byGroupValues.has(groupId)) byGroupValues.set(groupId, []);
        byGroupValues.get(groupId)!.push(days);
      }

      result.set(
        duration.id,
        new Map(
          [...byGroupValues.entries()].map(([groupId, values]) => [
            groupId,
            {
              id: duration.id,
              label: duration.label,
              avgDays: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null,
              sampleSize: values.length,
            },
          ]),
        ),
      );
    }

    return result;
  }

  private flattenContractRows(rows: any[], contract: DataContractConfig) {
    return rows.map((row) => {
      const flat: Record<string, unknown> = { РЎСЂРµР·: row.groupName };
      for (const metric of contract.metrics ?? []) {
        const value = row.metrics?.[metric.id];
        flat[metric.label] = value?.value ?? null;
        flat[`${metric.label}: СЃРґРµР»РѕРє`] = value?.dealCount ?? 0;
      }
      for (const conversion of contract.conversions ?? []) {
        flat[`${conversion.label}: %`] = row.conversions?.[conversion.id]?.conversion ?? null;
      }
      for (const duration of contract.durations ?? []) {
        flat[`${duration.label}: РґРЅРµР№`] = row.durations?.[duration.id]?.avgDays ?? null;
      }
      return flat;
    });
  }

  private async computeConversionReport(filters: ReportFilters, config: ReportConfig, role: UserRole) {
    const steps = config.steps ?? [];
    const computed: Array<{ id: string; label: string; count: number; amount: number; dealIds: string[] }> = [];

    for (const step of steps) {
      const dealIds = await this.resolveStepDealIds(step, filters, role);
      const amount = await this.sumDealAmount(dealIds);
      computed.push({
        id: step.id,
        label: step.label,
        count: dealIds.length,
        amount,
        dealIds,
      });
    }

    const denominatorMode = config.denominator ?? 'previous';
    const firstCount = computed[0]?.count ?? 0;
    const visibleSteps = computed.map((step, index) => {
      const denominator =
        denominatorMode === 'first'
          ? firstCount
          : index === 0
            ? step.count
            : computed[index - 1]?.count ?? 0;
      return {
        id: step.id,
        label: step.label,
        count: step.count,
        amount: step.amount,
        denominator,
        conversion: denominator > 0 ? Number(((step.count / denominator) * 100).toFixed(2)) : null,
      };
    });

    return {
      type: 'conversion',
      denominator: denominatorMode,
      steps: visibleSteps,
    };
  }

  private async computeCurrentSnapshot(filters: ReportFilters, role: UserRole) {
    const deals = await this.findFilteredDeals(filters, role);
    const totalAmount = deals.reduce((sum, deal) => sum + Number(deal.amount), 0);

    return {
      type: 'current',
      summary: {
        count: deals.length,
        totalAmount,
        avgAmount: deals.length ? Math.round(totalAmount / deals.length) : 0,
      },
      rows: deals.map((deal) => ({
        id: deal.id,
        title: deal.title,
        amount: Number(deal.amount),
        pipeline: deal.pipeline.name,
        stage: deal.stage.name,
        manager: deal.responsible?.name ?? null,
        updatedAt: deal.updatedAt,
      })),
    };
  }

  private async computeForecast(filters: ReportFilters) {
    const settings = await this.prisma.forecastSettings.findFirst();
    const monthFrom = startOfMonth();
    const monthTo = endOfMonth();
    const closingStageId = filters.stageIds?.[0] ?? settings?.closingStageId ?? undefined;

    const closedDeals = closingStageId
      ? await this.prisma.deal.findMany({
          where: {
            stageId: closingStageId,
            closedAt: { gte: monthFrom, lte: monthTo },
          },
          select: { id: true, amount: true },
        })
      : [];

    const weightedDeals = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        stage: { isWon: false, isLost: false },
      },
      include: {
        stage: { include: { probabilities: true } },
      },
    });

    const probabilityMode = settings?.probabilityMode ?? 'HYBRID';
    const weighted = weightedDeals.map((deal) => {
      const probability = deal.stage.probabilities[0];
      const manual = probability?.manualPercent == null ? null : Number(probability.manualPercent);
      const auto = probability?.autoPercent == null ? null : Number(probability.autoPercent);
      const percent =
        probabilityMode === 'MANUAL'
          ? manual ?? 0
          : probabilityMode === 'AUTO'
            ? auto ?? 0
            : manual ?? auto ?? 0;
      return {
        dealId: deal.id,
        title: deal.title,
        stage: deal.stage.name,
        amount: Number(deal.amount),
        probabilityPercent: percent,
        expectedAmount: Number(deal.amount) * (percent / 100),
        probabilitySource: manual != null ? 'manual' : 'auto',
        confidence: Number(probability?.confidence ?? 0),
      };
    });

    const shippingShoulder = await this.computeShippingShoulder(
      settings?.shippingPipelineId ?? undefined,
      settings?.shippingSuccessStageId ?? undefined,
    );

    const closedAmount = closedDeals.reduce((sum, deal) => sum + Number(deal.amount), 0);
    const weightedAmount = weighted.reduce((sum, deal) => sum + deal.expectedAmount, 0);

    return {
      type: 'forecast',
      forecast: {
        closedAmount,
        weightedAmount: Math.round(weightedAmount),
        totalForecast: Math.round(closedAmount + weightedAmount),
        closedDeals: closedDeals.length,
        openWeightedDeals: weighted.length,
        shippingShoulder,
      },
      rows: weighted,
    };
  }

  private async computeShippingShoulder(shippingPipelineId?: string, successStageId?: string) {
    if (!shippingPipelineId || !successStageId) {
      return { configured: false, avgDays: null, medianDays: null, sampleSize: 0 };
    }
    const shippingStageIds = await this.prisma.pipelineStage.findMany({
      where: { pipelineId: shippingPipelineId },
      select: { id: true },
    });
    const stageIds = shippingStageIds.map((stage) => stage.id);
    if (stageIds.length === 0) {
      return { configured: true, avgDays: null, medianDays: null, sampleSize: 0 };
    }

    const entries = await this.prisma.dealStageHistory.findMany({
      where: { toStageId: { in: stageIds } },
      orderBy: { movedAt: 'asc' },
      select: { dealId: true, toStageId: true, movedAt: true },
    });

    const firstEntryByDeal = new Map<string, Date>();
    const successByDeal = new Map<string, Date>();
    for (const entry of entries) {
      if (!firstEntryByDeal.has(entry.dealId)) firstEntryByDeal.set(entry.dealId, entry.movedAt);
      if (entry.toStageId === successStageId) successByDeal.set(entry.dealId, entry.movedAt);
    }

    const durations = [...successByDeal.entries()]
      .map(([dealId, successAt]) => {
        const firstAt = firstEntryByDeal.get(dealId);
        if (!firstAt || successAt <= firstAt) return null;
        return (successAt.getTime() - firstAt.getTime()) / 86_400_000;
      })
      .filter((value): value is number => value !== null);

    const avgDays = durations.length
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : null;

    return {
      configured: true,
      avgDays: avgDays == null ? null : Number(avgDays.toFixed(2)),
      medianDays: median(durations),
      sampleSize: durations.length,
    };
  }

  private async resolveStepDealIds(step: ConversionStep, filters: ReportFilters, role: UserRole) {
    if (step.type === 'stage_reached' && step.stageId) {
      return this.findDealIdsFromHistory({ toStageId: step.stageId }, filters, role);
    }
    if (step.type === 'stage_changed' && step.toStageId) {
      return this.findDealIdsFromHistory(
        {
          toStageId: step.toStageId,
          fromStageId: step.fromStageId,
        },
        filters,
        role,
      );
    }
    if (step.type === 'current_stage' && step.stageId) {
      const deals = await this.findFilteredDeals({ ...filters, stageIds: [step.stageId] }, role);
      return deals.map((deal) => deal.id);
    }
    if (step.type === 'current_field' && step.fieldId) {
      const deals = await this.findFilteredDeals(
        {
          ...filters,
          customFields: [{ fieldId: step.fieldId, operator: step.operator ?? 'equals', value: step.value }],
        },
        role,
      );
      return deals.map((deal) => deal.id);
    }
    return [];
  }

  private async findDealIdsFromHistory(
    stageFilter: { toStageId: string; fromStageId?: string },
    filters: ReportFilters,
    role: UserRole,
  ) {
    const movedAt: Record<string, Date> = {};
    if (filters.dateFrom) movedAt.gte = new Date(filters.dateFrom);
    if (filters.dateTo) movedAt.lte = new Date(filters.dateTo);

    const history = await this.prisma.dealStageHistory.findMany({
      where: {
        toStageId: stageFilter.toStageId,
        fromStageId: stageFilter.fromStageId,
        movedAt,
        NOT: [{ fromStageId: stageFilter.toStageId }],
        deal: await this.buildDealWhere(filters, role),
      },
      distinct: ['dealId'],
      select: { dealId: true },
    });
    return history.map((item) => item.dealId);
  }

  private async findDealIdsFromHistoryMany(stageIds: string[], filters: ReportFilters, role: UserRole, fromStageId?: string) {
    const history = await this.prisma.dealStageHistory.findMany({
      where: {
        toStageId: { in: stageIds },
        fromStageId: fromStageId || undefined,
        movedAt: this.dateRange(filters),
        NOT: [{ fromStageId: { in: stageIds } }],
        deal: await this.buildDealWhere(filters, role),
      },
      distinct: ['dealId'],
      select: { dealId: true },
    });
    return history.map((item) => item.dealId);
  }

  private async findDealsByIds(dealIds: string[]) {
    if (dealIds.length === 0) return [];
    return this.prisma.deal.findMany({
      where: { id: { in: dealIds }, deletedAt: null },
      include: {
        pipeline: true,
        stage: true,
        responsible: { include: { group: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });
  }

  private async findFilteredDeals(filters: ReportFilters, role: UserRole, extraWhere: Record<string, any> = {}) {
    const deals = await this.prisma.deal.findMany({
      where: {
        ...(await this.buildDealWhere(filters, role)),
        ...this.compactWhere(extraWhere),
      },
      include: {
        pipeline: true,
        stage: true,
        responsible: { include: { group: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });
    return deals.filter((deal) => this.matchesCustomFieldFilters(deal.customFields as any, filters.customFields));
  }

  private dateRange(filters: ReportFilters) {
    const range: Record<string, Date> = {};
    if (filters.dateFrom) range.gte = new Date(filters.dateFrom);
    if (filters.dateTo) range.lte = new Date(filters.dateTo);
    return Object.keys(range).length ? range : undefined;
  }

  private compactWhere(where: Record<string, any>) {
    return Object.fromEntries(Object.entries(where).filter(([, value]) => value !== undefined));
  }

  private async buildDealWhere(filters: ReportFilters, role: UserRole) {
    const where: Record<string, any> = { deletedAt: null };

    if (filters.pipelineIds?.length) where.pipelineId = { in: filters.pipelineIds };
    if (filters.stageIds?.length || filters.excludeStageIds?.length) {
      where.stageId = {};
      if (filters.stageIds?.length) where.stageId.in = filters.stageIds;
      if (filters.excludeStageIds?.length) where.stageId.notIn = filters.excludeStageIds;
    }
    if (filters.managerIds?.length) where.responsibleId = { in: filters.managerIds };
    if (filters.lossReasonIds?.length) where.lossReasonId = { in: filters.lossReasonIds };
    if (filters.amountFrom !== undefined || filters.amountTo !== undefined) {
      where.amount = {};
      if (filters.amountFrom !== undefined) where.amount.gte = filters.amountFrom;
      if (filters.amountTo !== undefined) where.amount.lte = filters.amountTo;
    }
    if (filters.tagIncludes?.length) where.tags = { hasSome: filters.tagIncludes };

    const visibleManagerIds = await this.visibleManagerIds(role, filters.groupIds);
    if (visibleManagerIds) {
      where.responsibleId = where.responsibleId
        ? { in: where.responsibleId.in.filter((id: string) => visibleManagerIds.includes(id)) }
        : { in: visibleManagerIds };
    }

    return where;
  }

  private async visibleManagerIds(role: UserRole, groupIds?: string[]) {
    const where: Record<string, any> = {};
    if (role === 'ROP') where.isVisible = true;
    if (groupIds?.length) where.groupId = { in: groupIds };

    if (Object.keys(where).length === 0) return null;
    const managers = await this.prisma.crmUser.findMany({ where, select: { id: true } });
    return managers.map((manager) => manager.id);
  }

  private matchesCustomFieldFilters(
    customFields: Record<string, any>,
    filters?: ReportFilters['customFields'],
  ) {
    if (!filters?.length) return true;
    return filters.every((filter) => {
      const field = customFields?.[filter.fieldId];
      const value = field?.value ?? field;
      if (filter.operator === 'is_set') return value !== undefined && value !== null && value !== '';
      if (filter.operator === 'contains') return String(value ?? '').includes(String(filter.value ?? ''));
      if (['lt', 'lte', 'gt', 'gte'].includes(filter.operator)) {
        const actual = this.toNumber(value);
        const expected = this.toNumber(filter.value);
        if (actual === null || expected === null) return false;
        if (filter.operator === 'lt') return actual < expected;
        if (filter.operator === 'lte') return actual <= expected;
        if (filter.operator === 'gt') return actual > expected;
        if (filter.operator === 'gte') return actual >= expected;
      }
      return String(value ?? '') === String(filter.value ?? '');
    });
  }

  private numericCustomField(customFields: Record<string, any>, fieldId: string) {
    const field = customFields?.[fieldId];
    return this.toNumber(field?.value ?? field) ?? 0;
  }

  private toNumber(value: unknown) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === null || raw === undefined || raw === '') return null;
    const number = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }

  private async sumDealAmount(dealIds: string[]) {
    if (dealIds.length === 0) return 0;
    const agg = await this.prisma.deal.aggregate({
      where: { id: { in: dealIds } },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }
}
