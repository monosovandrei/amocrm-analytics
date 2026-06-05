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
    dateFrom: workspaceFilters.dateFrom,
    dateTo: workspaceFilters.dateTo,
    pipelineIds: draft.pipelineId ? [draft.pipelineId] : workspaceFilters.pipelineIds ?? [],
    managerIds: workspaceFilters.managerIds ?? [],
    groupIds: workspaceFilters.groupIds ?? [],
  };

  if (draft.mode === 'contract') {
    const order = Number(existing?.config.order ?? templates.length + 1);
    const contract: DataContractConfig = {
      groupBy: draft.contractGroupBy,
      metrics: draft.contractMetrics.map((metric) => ({
        ...metric,
        measure: metric.type === 'conversion' ? undefined : metric.measure,
        display: metric.type === 'conversion' ? 'percent' : metric.display,
        pipelineId: metric.pipelineId || undefined,
        fromStageId: metric.fromStageId || undefined,
        stageIds: metric.stageIds.filter(Boolean),
        fieldId: metric.fieldId || undefined,
        fieldValue: metric.fieldOperator === 'is_set' ? undefined : metric.fieldValue,
        valueFieldId: metric.measure === 'deal_count' ? undefined : metric.valueFieldId || undefined,
        fromMetricId: metric.type === 'conversion' ? metric.fromMetricId : undefined,
        toMetricId: metric.type === 'conversion' ? metric.toMetricId : undefined,
      })),
      conversions: draft.contractConversions.filter((conversion) => conversion.fromMetricId && conversion.toMetricId),
      durations: draft.contractDurations.filter((duration) => duration.stageId),
    };

    const config: ReportConfig = {
      filters,
      metric: 'contract',
      display: 'table',
      contract,
      pinned: draft.pinned,
      size: draft.size,
      order,
      builder: draft,
      description: draft.description,
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

export function buildQueryFromTemplate(template: ReportTemplate, workspaceFilters: ReportFilters) {
  const reportFilters = template.config.filters ?? {};
  const filters: ReportFilters = {
    ...reportFilters,
    dateFrom: workspaceFilters.dateFrom ?? reportFilters.dateFrom,
    dateTo: workspaceFilters.dateTo ?? reportFilters.dateTo,
    pipelineIds: workspaceFilters.pipelineIds?.length ? workspaceFilters.pipelineIds : reportFilters.pipelineIds,
    managerIds: workspaceFilters.managerIds?.length ? workspaceFilters.managerIds : reportFilters.managerIds,
    groupIds: workspaceFilters.groupIds?.length ? workspaceFilters.groupIds : reportFilters.groupIds,
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
    const conversions = draft.contractMetrics.filter((metric) => metric.type === 'conversion').length;
    return `${draft.contractMetrics.length} показателей, ${conversions} конверсий, ${draft.contractDurations.length} длительностей`;
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
    const metricsCount = metrics.length;
    const conversionsCount = metrics.filter((metric) => metric.type === 'conversion').length;
    const rowsCount = ((result.rows ?? []) as unknown[]).length;
    return {
      value: `${metricsCount}`,
      caption: `показателей в контракте, ${conversionsCount} конверсий, ${rowsCount} срезов`,
    };
  }

  if (result.type === 'forecast') {
    const forecast = result.forecast ?? {};
    return {
      value: formatMoney(forecast.totalForecast),
      caption: `Закрыто: ${formatMoney(forecast.closedAmount)} / Взвешено: ${formatMoney(forecast.weightedAmount)}`,
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
    currency: 'RUB',
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

export function formatDateTime(value: unknown) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(String(value)));
}
