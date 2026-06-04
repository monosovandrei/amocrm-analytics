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
  type: 'created_deals' | 'stage_reached' | 'current_stage' | 'field_condition' | 'conversion';
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
}

export interface DataContractConfig {
  groupBy?: 'manager' | 'none';
  metrics?: DataContractMetric[];
  conversions?: DataContractConversion[];
  durations?: DataContractDuration[];
}

export interface ReportConfig {
  metric?: 'count' | 'total_amount' | 'avg_amount' | 'conversion' | 'forecast' | 'contract';
  denominator?: 'previous' | 'first';
  steps?: ConversionStep[];
  contract?: DataContractConfig;
  breakdownBy?: 'department' | 'manager' | 'group';
  display?: 'kpi' | 'funnel' | 'table' | 'forecast';
  pinned?: boolean;
  size?: 'sm' | 'md' | 'lg';
  order?: number;
  builder?: Record<string, unknown>;
}
