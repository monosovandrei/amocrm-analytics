import type {
  ContractMetricPayload,
  ConversionStep,
  DataContractConfig,
  Options,
  ReportConfig,
  ReportDraft,
  ReportFilters,
  ReportTemplate,
  SourceType,
} from './report-types';
export function buildReportPayload(
  draft: ReportDraft,
  workspaceFilters: ReportFilters,
  templates: ReportTemplate[],
  activeReportId: string | null,
  options: Options | null,
) {
  const existing = activeReportId ? templates.find((item) => item.id === activeReportId) : null;
  const filters: ReportFilters = {
    ...resolveReportPeriod(workspaceFilters),
    pipelineIds: draft.pipelineId ? [draft.pipelineId] : workspaceFilters.pipelineIds ?? [],
    managerIds: workspaceFilters.managerIds ?? [],
    groupIds: workspaceFilters.groupIds ?? [],
  };

  if (draft.mode === 'contract') {
    const order = Number(existing?.config.order ?? templates.length + 1);
    const contract: DataContractConfig = {
      entity: draft.entity,
      groupBy: draft.contractGroupBy,
      metrics: draft.contractMetrics.map((metric) => ({
        ...metric,
        measure: metric.type === 'conversion' || metric.type === 'task_count' ? undefined : metric.measure,
        display: metric.type === 'conversion' ? 'percent' : metric.display,
        pipelineId: metric.pipelineId || undefined,
        fromStageId: metric.fromStageId || undefined,
        stageIds: metric.stageIds.filter(Boolean),
        fieldId: metric.fieldId || undefined,
        fieldValue: metric.fieldOperator === 'is_set' ? undefined : metric.fieldValue,
        valueFieldId: metric.measure === 'deal_count' ? undefined : metric.valueFieldId || undefined,
        fromMetricId: metric.type === 'conversion' ? metric.fromMetricId : undefined,
        toMetricId: metric.type === 'conversion' ? metric.toMetricId : undefined,
        formula: metric.type === 'formula' ? metric.formula : undefined,
        extraFilters: metric.extraFilters
          .filter((filter) => {
            if (filter.subject === 'deal_field') return Boolean(filter.fieldId);
            if (filter.operator === 'within_last' || filter.operator === 'older_than') return filter.amount > 0;
            if (filter.operator === 'is_set') return true;
            return filter.value.trim().length > 0;
          })
          .map((filter) => ({
            id: filter.id,
            subject: filter.subject,
            fieldId: filter.subject === 'deal_field' ? filter.fieldId : undefined,
            operator: filter.operator,
            value: filter.operator === 'within_last' || filter.operator === 'older_than' || filter.operator === 'is_set'
              ? undefined
              : filter.value,
            amount: filter.operator === 'within_last' || filter.operator === 'older_than' ? filter.amount : undefined,
            unit: filter.operator === 'within_last' || filter.operator === 'older_than' ? filter.unit : undefined,
          })),
      })),
      conversions: draft.contractConversions.filter((conversion) => conversion.fromMetricId && conversion.toMetricId),
      durations: draft.contractDurations.filter((duration) => duration.stageId),
      includeRowTotal: draft.includeRowTotal,
      rowTotalMode: draft.rowTotalMode,
      includeSummaryRow: draft.includeSummaryRow,
      summaryRowMode: draft.summaryRowMode,
    };

    const config: ReportConfig = {
      filters,
      metric: 'contract',
      display: 'table',
      contract,
      pinned: draft.pinned,
      order,
      builder: draft,
      description: draft.description,
      visibleUserIds: draft.visibleUserIds,
      conditionLabel: buildConditionLabel(draft, options),
    };

    return {
      id: activeReportId ?? undefined,
      name: draft.name.trim(),
      sourceType: 'EVENT' as SourceType,
      filters,
      config,
    };
  }

  let sourceType: SourceType = 'CURRENT';
  let steps: ConversionStep[] | undefined;
  let metric = draft.metric;

  if (draft.operator === 'stage_reached') {
    sourceType = 'EVENT';
    steps = [
      {
        id: 'step-1',
        label: getStageName(options, draft.stageId) || 'Переход в этап',
        type: 'stage_reached',
        stageId: draft.stageId,
      },
    ];
  }

  if (draft.operator === 'stage_changed') {
    sourceType = 'EVENT';
    steps = [
      {
        id: 'step-1',
        label: `${getStageName(options, draft.fromStageId) || 'Любой этап'} → ${getStageName(options, draft.toStageId) || 'этап'}`,
        type: 'stage_changed',
        fromStageId: draft.fromStageId || undefined,
        toStageId: draft.toStageId,
      },
    ];
  }

  if (draft.operator === 'current_stage') {
    filters.stageIds = [draft.stageId];
  }

  if (draft.operator === 'not_current_stage') {
    filters.excludeStageIds = [draft.stageId];
  }

  if (draft.operator === 'field_equals') {
    filters.customFields = [{ fieldId: draft.fieldId, operator: 'equals', value: draft.fieldValue }];
  }

  if (draft.operator === 'field_filled') {
    filters.customFields = [{ fieldId: draft.fieldId, operator: 'is_set' }];
  }

  if (draft.operator === 'forecast') {
    sourceType = 'CURRENT';
    metric = 'forecast';
  }

  const order = Number(existing?.config.order ?? templates.length + 1);
  const config: ReportConfig = {
    filters,
    metric,
    denominator: draft.denominator,
    steps,
    display: draft.operator === 'forecast' ? 'forecast' : draft.display,
    pinned: draft.pinned,
    size: draft.size,
    order,
    builder: draft,
    description: draft.description,
    visibleUserIds: draft.visibleUserIds,
    conditionLabel: buildConditionLabel(draft, options),
  };

  return {
    id: activeReportId ?? undefined,
    name: draft.name.trim(),
    sourceType,
    filters,
    config,
  };
}

function resolveReportPeriod(filters: ReportFilters): ReportFilters {
  if (filters.periodMode === 'relative') {
    const amount = Math.max(1, Number(filters.relativeAmount ?? 7));
    const unit = filters.relativeUnit ?? 'days';
    const to = new Date();
    const from = new Date(to);
    if (unit === 'hours') from.setHours(from.getHours() - amount);
    if (unit === 'days') from.setDate(from.getDate() - amount);
    if (unit === 'weeks') from.setDate(from.getDate() - amount * 7);
    if (unit === 'months') from.setMonth(from.getMonth() - amount);
    return { ...filters, dateFrom: from.toISOString(), dateTo: to.toISOString() };
  }

  if (filters.periodMode === 'preset' && filters.periodPreset) {
    const { from, to } = presetPeriod(filters.periodPreset);
    return { ...filters, dateFrom: from.toISOString(), dateTo: to.toISOString() };
  }

  return filters;
}

function presetPeriod(preset: NonNullable<ReportFilters['periodPreset']>) {
  const now = new Date();
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const endOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const day = now.getDay() || 7;

  if (preset === 'today') return { from: startOfDay(now), to: endOfDay(now) };
  if (preset === 'yesterday') {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return { from: startOfDay(date), to: endOfDay(date) };
  }
  if (preset === 'this_week') {
    const from = startOfDay(now);
    from.setDate(from.getDate() - day + 1);
    return { from, to: endOfDay(now) };
  }
  if (preset === 'last_week') {
    const from = startOfDay(now);
    from.setDate(from.getDate() - day - 6);
    const to = endOfDay(from);
    to.setDate(to.getDate() + 6);
    return { from, to };
  }
  if (preset === 'last_month') {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { from, to };
  }
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: endOfDay(now),
  };
}

export function buildQueryFromTemplate(template: ReportTemplate, workspaceFilters: ReportFilters) {
  const reportFilters = template.config.filters ?? {};
  const resolvedWorkspaceFilters = resolveReportPeriod(workspaceFilters);
  const filters: ReportFilters = {
    ...reportFilters,
    dateFrom: resolvedWorkspaceFilters.dateFrom ?? reportFilters.dateFrom,
    dateTo: resolvedWorkspaceFilters.dateTo ?? reportFilters.dateTo,
    pipelineIds: reportFilters.pipelineIds,
    managerIds: reportFilters.managerIds,
    groupIds: reportFilters.groupIds,
  };
  return {
    name: template.name,
    sourceType: template.sourceType,
    filters,
    config: {
      ...template.config,
      filters,
    },
  };
}

export function validateDraft(draft: ReportDraft) {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('Укажите название отчёта');
  if (draft.mode === 'contract') {
    if (draft.contractMetrics.length === 0) errors.push('Добавьте хотя бы один показатель в контракт данных');
    for (const metric of draft.contractMetrics) {
      if (!metric.label.trim()) errors.push('У каждого показателя должно быть название');
      if (metric.type === 'conversion') {
        if (!metric.fromMetricId || !metric.toMetricId) errors.push(`Выберите оба показателя для конверсии “${metric.label}”`);
        if (metric.fromMetricId === metric.toMetricId) errors.push(`Конверсия “${metric.label}” не может ссылаться на один и тот же показатель`);
        continue;
      }
      if (metric.type === 'formula') {
        if (!metric.formula.trim()) errors.push(`Укажите формулу для показателя “${metric.label}”`);
        continue;
      }
      if (metric.measure === 'deal_count' && metric.display !== 'number') {
        errors.push(`Показатель “${metric.label}” с количеством сделок может отображаться только числом`);
      }
      if ((metric.measure === 'field_sum' || metric.measure === 'field_avg') && metric.display === 'percent') {
        errors.push(`Показатель “${metric.label}” по полю нельзя отображать процентом`);
      }
      if ((metric.type === 'stage_reached' || metric.type === 'current_stage') && metric.stageIds.length === 0) {
        errors.push(`Выберите этапы для показателя “${metric.label}”`);
      }
      if (metric.type === 'field_condition' && !metric.fieldId) {
        errors.push(`Выберите поле amoCRM для показателя “${metric.label}”`);
      }
      if (metric.type === 'field_condition' && metric.fieldOperator !== 'is_set' && !metric.fieldValue.trim()) {
        errors.push(`Укажите значение поля для показателя “${metric.label}”`);
      }
      for (const filter of metric.extraFilters) {
        if (filter.subject === 'deal_field' && !filter.fieldId) {
          errors.push(`Выберите поле amoCRM в дополнительном условии показателя “${metric.label}”`);
        }
        if (filter.operator !== 'is_set' && filter.operator !== 'within_last' && filter.operator !== 'older_than' && !filter.value.trim()) {
          errors.push(`Укажите значение в дополнительном условии показателя “${metric.label}”`);
        }
        if ((filter.operator === 'within_last' || filter.operator === 'older_than') && filter.amount <= 0) {
          errors.push(`Укажите период в дополнительном условии показателя “${metric.label}”`);
        }
      }
    }
    for (const conversion of draft.contractConversions) {
      if (!conversion.fromMetricId || !conversion.toMetricId) errors.push('В каждой конверсии выберите оба показателя');
    }
    return errors;
  }
  if (['stage_reached', 'current_stage', 'not_current_stage'].includes(draft.operator) && !draft.stageId) {
    errors.push('Выберите этап amoCRM');
  }
  if (draft.operator === 'stage_changed' && !draft.toStageId) {
    errors.push('Выберите этап, в который должна перейти сделка');
  }
  if ((draft.operator === 'field_equals' || draft.operator === 'field_filled') && !draft.fieldId) {
    errors.push('Выберите поле сделки amoCRM');
  }
  if (draft.operator === 'field_equals' && !draft.fieldValue.trim()) {
    errors.push('Укажите значение поля');
  }
  return errors;
}

export function buildConditionLabel(draft: ReportDraft, options: Options | null) {
  if (draft.mode === 'contract') {
    return draft.description.trim() || 'Настраиваемый отчёт';
  }
  if (draft.operator === 'stage_reached') return `Сделка перешла в этап “${getStageName(options, draft.stageId) || 'этап'}”`;
  if (draft.operator === 'stage_changed') {
    return `Сделка перешла из “${getStageName(options, draft.fromStageId) || 'любого этапа'}” в “${getStageName(options, draft.toStageId) || 'этап'}”`;
  }
  if (draft.operator === 'current_stage') return `Сделка сейчас находится в этапе “${getStageName(options, draft.stageId) || 'этап'}”`;
  if (draft.operator === 'not_current_stage') return `Сделка сейчас не находится в этапе “${getStageName(options, draft.stageId) || 'этап'}”`;
  if (draft.operator === 'field_equals') return `Поле “${getFieldName(options, draft.fieldId) || 'поле'}” равно “${draft.fieldValue || 'значение'}”`;
  if (draft.operator === 'field_filled') return `Поле “${getFieldName(options, draft.fieldId) || 'поле'}” заполнено`;
  return 'Прогноз: закрытые сделки + взвешенная воронка + плечо отгрузки';
}

export function getStageName(options: Options | null, stageId: string) {
  if (!stageId) return '';
  return options?.pipelines.flatMap((pipeline) => pipeline.stages).find((stage) => stage.id === stageId)?.name ?? '';
}

export function getFieldName(options: Options | null, fieldId: string) {
  if (!fieldId) return '';
  return options?.customFields.find((field) => field.externalId === fieldId)?.name ?? '';
}

export function getMetric(template: Pick<ReportTemplate, 'name' | 'config'>, result: Record<string, any> | null) {
  if (!result) return { value: 'нет данных', caption: 'Данные ещё не загружены' };
  const metric = template.config.metric ?? 'count';

  if (result.type === 'contract') {
    const metrics = (result.metrics ?? []) as ContractMetricPayload[];
    const headlineMetric =
      metrics.find((item) => item.id === 'weighted_total') ??
      metrics.find((item) => String(item.label ?? '').toLowerCase().replace(/ё/g, 'е').trim() === 'итого взвешенно') ??
      metrics[0];
    const summaryMetric = headlineMetric
      ? ((result.summaryRows?.[0]?.metrics ?? {}) as Record<string, any>)[headlineMetric.id]
      : null;
    const firstDuration = (result.durations ?? [])[0] as { id: string; label: string } | undefined;
    if (!headlineMetric && firstDuration) {
      const values = ((result.rows ?? []) as Array<Record<string, any>>)
        .map((row) => Number((row.durations as Record<string, any> | undefined)?.[firstDuration.id]?.avgDays))
        .filter((value) => Number.isFinite(value));
      const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return {
        value: avg == null ? 'нет данных' : formatDurationFromDays(Number(avg.toFixed(2))),
        caption: firstDuration.label,
      };
    }
    return {
      value: summaryMetric ? formatMetricValue(summaryMetric.value, summaryMetric.unit) : 'нет данных',
      caption: headlineMetric?.label ?? '',
    };
  }

  if (result.type === 'dealCycle' || result.type === 'dealStageAge') {
    const summary = result.summary ?? {};
    const stageValues = ((summary.stages ?? []) as Array<{ avgDays?: number | null; sampleSize?: number }>)
      .filter((stage) => stage.avgDays !== null && stage.avgDays !== undefined && Number(stage.sampleSize ?? 0) > 0);
    const weightedStageAvg = stageValues.length
      ? stageValues.reduce((sum, stage) => sum + Number(stage.avgDays) * Number(stage.sampleSize ?? 0), 0) /
        stageValues.reduce((sum, stage) => sum + Number(stage.sampleSize ?? 0), 0)
      : null;
    if (result.type === 'dealStageAge') {
      return {
        value: weightedStageAvg == null ? 'нет данных' : formatDurationFromDays(weightedStageAvg),
        caption: `Среднее нахождение в текущем этапе. Сделок в работе: ${formatNumber(summary.totalDeals ?? 0)}`,
      };
    }
    const successAvg = summary.successCycle?.avgDays;
    const lostAvg = summary.lostCycle?.avgDays;
    const avg = successAvg ?? lostAvg ?? weightedStageAvg;
    const caption =
      successAvg != null
        ? 'Средний цикл до успеха'
        : lostAvg != null
          ? 'Средний цикл до отказа'
          : 'Среднее время прохождения этапа';
    return {
      value: avg == null ? 'нет данных' : formatDurationFromDays(avg),
      caption: `${caption}. Сделок в срезе: ${formatNumber(summary.totalDeals ?? 0)}`,
    };
  }

  if (result.type === 'lossReasons') {
    return {
      value: formatNumber(result.summary?.total ?? 0),
      caption: `Причин отказа: ${formatNumber((result.rows ?? []).length)}`,
    };
  }

  if (result.type === 'forecast') {
    const forecast = result.forecast ?? {};
    return {
      value: formatMoney(forecast.totalForecast),
      caption: `Закрыто: ${formatMoney(forecast.closedAmount)} / Взвешено: ${formatMoney(forecast.weightedAmount)}`,
    };
  }

  if (result.type === 'revenueProfitForecast') {
    const summary = result.summary ?? {};
    const profitText = result.profit?.available ? ` / прибыль: ${formatMoney(summary.profit)}` : '';
    return {
      value: formatMoney(summary.revenue),
      caption: `До конца месяца: ${formatNumber(summary.count ?? 0)} сделок${profitText}`,
    };
  }

  if (result.type === 'conversion') {
    const steps = (result.steps ?? []) as Array<Record<string, any>>;
    const step = steps[steps.length - 1];
    if (!step) return { value: '0', caption: 'За период переходов не найдено' };
    if (metric === 'total_amount') return { value: formatMoney(step.amount), caption: `Сделок: ${step.count}` };
    if (metric === 'conversion') {
      return {
        value: step.conversion == null ? 'нет данных' : `${formatNumber(step.conversion)}%`,
        caption: `База: ${step.denominator ?? 0}, событий: ${step.count}`,
      };
    }
    return { value: formatNumber(step.count), caption: `Сумма сделок: ${formatMoney(step.amount)}` };
  }

  const summary = result.summary ?? {};
  if (metric === 'total_amount') return { value: formatMoney(summary.totalAmount), caption: `Сделок: ${summary.count ?? 0}` };
  if (metric === 'avg_amount') return { value: formatMoney(summary.avgAmount), caption: `Сделок: ${summary.count ?? 0}` };
  return { value: formatNumber(summary.count ?? 0), caption: `Сумма: ${formatMoney(summary.totalAmount)}` };
}

export function formatMoney(value: unknown) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(number);
}

export function formatMetricValue(value: unknown, unit: unknown) {
  if (value === null || value === undefined) return 'нет данных';
  if (unit === 'percent') return `${formatNumber(value)}%`;
  if (unit === 'money') return formatMoney(value);
  return formatNumber(value);
}

export function formatNumber(value: unknown) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value ?? 0));
}

export function formatPercent(value: unknown) {
  if (value === null || value === undefined) return '-';
  return `${formatNumber(value)}%`;
}

export function formatDays(value: unknown) {
  if (value === null || value === undefined) return 'нет данных';
  return `${formatNumber(value)} дн.`;
}

export function formatDurationFromDays(value: unknown) {
  if (value === null || value === undefined) return 'нет данных';
  const days = Number(value);
  if (!Number.isFinite(days)) return 'нет данных';

  const totalMinutes = Math.round(days * 24 * 60);
  if (totalMinutes < 60) return `${Math.max(totalMinutes, 1)} мин.`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours} ч ${minutes} мин.` : `${hours} ч`;

  const wholeDays = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${wholeDays} дн. ${restHours} ч` : `${wholeDays} дн.`;
}

export function formatDateTime(value: unknown) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(String(value)));
}

export function formatMoscowDateTime(value: unknown) {
  if (!value) return 'нет данных';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(String(value)));
}
