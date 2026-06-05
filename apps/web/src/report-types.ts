export type Tab = 'workspace' | 'builder' | 'integration' | 'settings';
export type UserRole = 'ADMIN' | 'ROP';
export type SourceType = 'EVENT' | 'CURRENT';
export type MetricType = 'count' | 'total_amount' | 'avg_amount' | 'conversion' | 'forecast' | 'contract';
export type DisplayType = 'kpi' | 'funnel' | 'table' | 'forecast';
export type WidgetSize = 'sm' | 'md' | 'lg';
export type DenominatorType = 'previous' | 'first';
export type ReportMode = 'contract' | 'single';
export type ContractMetricType = 'created_deals' | 'stage_reached' | 'current_stage' | 'field_condition' | 'conversion';
export type ContractMeasure = 'deal_count' | 'field_sum' | 'field_avg';
export type ContractDisplay = 'number' | 'money' | 'percent';
export type FieldOperator = 'equals' | 'contains' | 'is_set' | 'lt' | 'lte' | 'gt' | 'gte';
export type BuilderOperator =
  | 'stage_reached'
  | 'stage_changed'
  | 'current_stage'
  | 'not_current_stage'
  | 'field_equals'
  | 'field_filled'
  | 'forecast';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface PipelineStage {
  id: string;
  externalId?: string;
  name: string;
  position?: number;
  isWon: boolean;
  isLost: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  isShippingPipeline: boolean;
  stages: PipelineStage[];
}

export interface Manager {
  id: string;
  name: string;
  email?: string;
  isVisible: boolean;
  group?: { id: string; name: string } | null;
}

export interface Group {
  id: string;
  name: string;
  isVisible: boolean;
}

export interface CustomFieldDefinition {
  id: string;
  externalId: string;
  name: string;
  entityType: string;
}

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface Options {
  pipelines: Pipeline[];
  managers: Manager[];
  groups: Group[];
  customFields: CustomFieldDefinition[];
}

export interface ReportFilters {
  dateFrom?: string;
  dateTo?: string;
  pipelineIds?: string[];
  stageIds?: string[];
  excludeStageIds?: string[];
  managerIds?: string[];
  groupIds?: string[];
  customFields?: Array<{ fieldId: string; operator: FieldOperator; value?: unknown }>;
}

export interface ConversionStep {
  id: string;
  label: string;
  type: 'stage_reached' | 'stage_changed' | 'current_stage' | 'current_field';
  stageId?: string;
  fromStageId?: string;
  toStageId?: string;
  fieldId?: string;
  operator?: FieldOperator;
  value?: unknown;
}

export interface ContractMetricDraft {
  id: string;
  label: string;
  type: ContractMetricType;
  measure: ContractMeasure;
  display: ContractDisplay;
  pipelineId: string;
  fromStageId: string;
  stageIds: string[];
  fieldId: string;
  fieldOperator: FieldOperator;
  fieldValue: string;
  valueFieldId: string;
  fromMetricId: string;
  toMetricId: string;
}

export interface ContractConversionDraft {
  id: string;
  label: string;
  fromMetricId: string;
  toMetricId: string;
}

export interface ContractDurationDraft {
  id: string;
  label: string;
  stageId: string;
}

export interface ContractMetricPayload {
  id: string;
  label: string;
  type: ContractMetricType;
  measure?: ContractMeasure;
  display?: ContractDisplay;
  pipelineId?: string;
  fromStageId?: string;
  stageIds?: string[];
  fieldId?: string;
  fieldOperator?: FieldOperator;
  fieldValue?: unknown;
  valueFieldId?: string;
  fromMetricId?: string;
  toMetricId?: string;
  amountFieldId?: string;
  marginFieldId?: string;
}

export interface DataContractConfig {
  groupBy?: 'manager' | 'none';
  metrics?: ContractMetricPayload[];
  conversions?: ContractConversionDraft[];
  durations?: ContractDurationDraft[];
}

export interface ReportDraft {
  mode: ReportMode;
  name: string;
  description: string;
  entity: 'deal';
  operator: BuilderOperator;
  pipelineId: string;
  stageId: string;
  fromStageId: string;
  toStageId: string;
  fieldId: string;
  fieldValue: string;
  metric: MetricType;
  display: DisplayType;
  denominator: DenominatorType;
  contractGroupBy: 'manager' | 'none';
  contractMetrics: ContractMetricDraft[];
  contractConversions: ContractConversionDraft[];
  contractDurations: ContractDurationDraft[];
  pinned: boolean;
  size: WidgetSize;
}

export interface ReportConfig {
  filters?: ReportFilters;
  metric?: MetricType;
  denominator?: DenominatorType;
  steps?: ConversionStep[];
  contract?: DataContractConfig;
  display?: DisplayType;
  pinned?: boolean;
  size?: WidgetSize;
  order?: number;
  builder?: ReportDraft;
  description?: string;
  conditionLabel?: string;
}

export interface ReportTemplate {
  id: string;
  name: string;
  sourceType: SourceType;
  config: ReportConfig;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DashboardLayout {
  config?: {
    reports?: Record<string, { pinned?: boolean; order?: number; size?: WidgetSize }>;
  };
}

export interface ForecastSettings {
  settings?: {
    closingStageId?: string | null;
    shippingPipelineId?: string | null;
    shippingSuccessStageId?: string | null;
    probabilityMode?: 'MANUAL' | 'AUTO' | 'HYBRID';
    minSampleSize?: number;
  };
  probabilities?: Array<{
    stageId: string;
    manualPercent?: number | null;
    autoPercent?: number | null;
    sampleSize?: number;
    confidence?: number;
    stage: PipelineStage & { pipeline?: Pipeline };
  }>;
}

