export interface ReportFilters {
  dateFrom?: string;
  dateTo?: string;
  pipelineIds?: string[];
  stageIds?: string[];
  excludeStageIds?: string[];
  managerIds?: string[];
  groupIds?: string[];
  tagIncludes?: string[];
  lossReasonIds?: string[];
  amountFrom?: number;
  amountTo?: number;
  customFields?: Array<{
    fieldId: string;
    operator: 'equals' | 'contains' | 'is_set' | 'lt' | 'lte' | 'gt' | 'gte';
    value?: unknown;
  }>;
}

export interface ConversionStep {
  id: string;
  label: string;
  type: 'stage_reached' | 'stage_changed' | 'current_stage' | 'current_field' | 'field_changed';
  stageId?: string;
  fromStageId?: string;
  toStageId?: string;
  fieldId?: string;
  operator?: 'equals' | 'contains' | 'is_set' | 'lt' | 'lte' | 'gt' | 'gte';
  value?: unknown;
}

export interface DataContractMetric {
  id: string;
  label: string;
  type:
    | 'created_deals'
    | 'stage_reached'
    | 'current_stage'
    | 'field_condition'
    | 'field_changed'
    | 'conversion'
    | 'formula'
    | 'weighted_stage_sum'
    | 'task_count';
  measure?: 'deal_count' | 'field_sum' | 'field_avg';
  display?: 'number' | 'money' | 'percent';
  pipelineId?: string;
  fromStageId?: string;
  stageIds?: string[];
  fieldId?: string;
  fieldOperator?: 'equals' | 'contains' | 'is_set' | 'lt' | 'lte' | 'gt' | 'gte';
  fieldValue?: unknown;
  valueFieldId?: string;
  fromMetricId?: string;
  toMetricId?: string;
  amountFieldId?: string;
  marginFieldId?: string;
  formula?: string;
  successStageId?: string;
  successStageIds?: string[];
  successStageByPipelineId?: Record<string, string>;
  successStageIdsByPipelineId?: Record<string, string[]>;
  probabilityStageScope?: 'stage' | 'metric';
  probabilityReachedStageIds?: string[];
  inferSuccessAsReached?: boolean;
  defaultProbability?: number;
  extraFilters?: DataContractFilter[];
  createdWithinAmount?: number;
  createdWithinUnit?: 'hours' | 'days' | 'weeks' | 'months';
  lastNoteOlderThanAmount?: number;
  lastNoteOlderThanUnit?: 'hours' | 'days' | 'weeks' | 'months';
}

export interface DataContractFilter {
  id?: string;
  subject:
    | 'deal_created_at'
    | 'deal_updated_at'
    | 'deal_closed_at'
    | 'deal_expected_close_at'
    | 'deal_amount'
    | 'deal_stage'
    | 'deal_responsible'
    | 'deal_group'
    | 'deal_field'
    | 'last_note_created_at'
    | 'last_note_text'
    | 'task_created_at'
    | 'task_updated_at'
    | 'task_due_at'
    | 'task_completed_at'
    | 'task_type'
    | 'task_status'
    | 'task_text'
    | 'task_responsible'
    | 'task_group';
  fieldId?: string;
  operator:
    | 'equals'
    | 'contains'
    | 'is_set'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'within_last'
    | 'older_than';
  value?: unknown;
  amount?: number;
  unit?: 'hours' | 'days' | 'weeks' | 'months';
}

export interface DataContractConversion {
  id: string;
  label: string;
  fromMetricId: string;
  toMetricId: string;
}

export interface DataContractDuration {
  id: string;
  label: string;
  stageId: string;
  onlyExited?: boolean;
  startMode?: 'stage_entry' | 'sales_responsible_task';
}

export interface DataContractConfig {
  entity?: 'deal' | 'task';
  groupBy?: 'manager' | 'group' | 'none';
  metrics?: DataContractMetric[];
  conversions?: DataContractConversion[];
  durations?: DataContractDuration[];
  includeRowTotal?: boolean;
  rowTotalMode?: 'sum' | 'avg';
  includeSummaryRow?: boolean;
  summaryRowMode?: 'sum' | 'avg';
}

export interface ReportConfig {
  filters?: ReportFilters;
  metric?:
    | 'count'
    | 'total_amount'
    | 'avg_amount'
    | 'conversion'
    | 'forecast'
    | 'contract'
    | 'deal_cycle'
    | 'deal_stage_age'
    | 'revenue_profit_forecast'
    | 'loss_reasons';
  denominator?: 'previous' | 'first';
  steps?: ConversionStep[];
  contract?: DataContractConfig;
  breakdownBy?: 'department' | 'manager' | 'group';
  display?: 'kpi' | 'funnel' | 'table' | 'forecast' | 'cycle';
  pinned?: boolean;
  size?: 'sm' | 'md' | 'lg';
  order?: number;
  dashboardSection?: 'sales' | 'csm' | 'forecast';
  lockPipelineFilter?: boolean;
  lockTeamFilter?: boolean;
  builtinKey?: string;
  builder?: Record<string, unknown>;
  description?: string;
  visibleUserIds?: string[];
  conditionLabel?: string;
}
