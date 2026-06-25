export type Tab = 'workspace' | 'builder' | 'integration' | 'platform' | 'settings';
export type UserRole = 'ADMIN' | 'ROP';
export type PlatformBusinessRole = 'OWNER' | 'ROP' | 'MANAGER';
export type SourceType = 'EVENT' | 'CURRENT';
export type MetricType =
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
export type DisplayType = 'kpi' | 'funnel' | 'table' | 'forecast' | 'cycle';
export type WidgetSize = 'sm' | 'md' | 'lg';
export type DenominatorType = 'previous' | 'first';
export type ReportMode = 'contract' | 'single';
export type ContractMetricType =
  | 'created_deals'
  | 'stage_reached'
  | 'current_stage'
  | 'field_condition'
  | 'field_changed'
  | 'conversion'
  | 'formula'
  | 'task_count';
export type ContractMeasure = 'deal_count' | 'field_sum' | 'field_avg';
export type ContractDisplay = 'number' | 'money' | 'percent';
export type PeriodMode = 'preset' | 'custom' | 'relative';
export type PeriodPreset = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';
export type RelativeUnit = 'hours' | 'days' | 'weeks' | 'months';
export type FieldOperator = 'equals' | 'contains' | 'is_set' | 'lt' | 'lte' | 'gt' | 'gte';
export type ContractFilterSubject =
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
export type ContractFilterOperator = FieldOperator | 'within_last' | 'older_than';
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
  businessRole?: PlatformBusinessRole;
  crmUserId?: string | null;
}

export interface PipelineStage {
  id: string;
  externalId?: string;
  name: string;
  position?: number;
  color?: string | null;
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

export interface CrmTag {
  id: string;
  externalId: string;
  entityType: string;
  name: string;
  color?: string | null;
}

export interface Catalog {
  id: string;
  externalId: string;
  name: string;
  type?: string | null;
}

export interface CrmSource {
  id: string;
  externalId: string;
  name: string;
  pipelineId?: string | null;
}

export interface CustomerStatus {
  id: string;
  externalId: string;
  name: string;
  color?: string | null;
}

export interface CustomerSegment {
  id: string;
  externalId: string;
  name: string;
}

export interface CrmRole {
  id: string;
  externalId: string;
  name: string;
}

export interface TaskTypeOption {
  id: string;
  name: string;
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
  tags?: CrmTag[];
  catalogs?: Catalog[];
  sources?: CrmSource[];
  customerStatuses?: CustomerStatus[];
  customerSegments?: CustomerSegment[];
  roles?: CrmRole[];
  appUsers?: User[];
  taskTypes?: TaskTypeOption[];
}

export interface ReportFilters {
  periodMode?: PeriodMode;
  periodPreset?: PeriodPreset;
  relativeAmount?: number;
  relativeUnit?: RelativeUnit;
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
  formula: string;
  extraFilters: ContractFilterDraft[];
}

export interface ContractFilterDraft {
  id: string;
  subject: ContractFilterSubject;
  fieldId: string;
  operator: ContractFilterOperator;
  value: string;
  amount: number;
  unit: RelativeUnit;
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
  onlyExited?: boolean;
  startMode?: 'stage_entry' | 'sales_responsible_task';
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
  formula?: string;
  extraFilters?: Array<{
    id?: string;
    subject: ContractFilterSubject;
    fieldId?: string;
    operator: ContractFilterOperator;
    value?: unknown;
    amount?: number;
    unit?: RelativeUnit;
  }>;
}

export interface DataContractConfig {
  entity?: 'deal' | 'task';
  groupBy?: 'manager' | 'group' | 'none';
  metrics?: ContractMetricPayload[];
  conversions?: ContractConversionDraft[];
  durations?: ContractDurationDraft[];
  includeRowTotal?: boolean;
  rowTotalMode?: 'sum' | 'avg';
  includeSummaryRow?: boolean;
  summaryRowMode?: 'sum' | 'avg';
}

export interface ReportDraft {
  mode: ReportMode;
  name: string;
  description: string;
  entity: 'deal' | 'task';
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
  contractGroupBy: 'manager' | 'group' | 'none';
  visibleUserIds: string[];
  includeRowTotal: boolean;
  rowTotalMode: 'sum' | 'avg';
  includeSummaryRow: boolean;
  summaryRowMode: 'sum' | 'avg';
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
  dashboardSection?: 'sales' | 'csm' | 'forecast';
  lockPipelineFilter?: boolean;
  lockTeamFilter?: boolean;
  builtinKey?: string;
  builder?: ReportDraft;
  description?: string;
  visibleUserIds?: string[];
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

export interface PlatformOverview {
  telegram?: Record<string, any>;
  alertsCount: number;
  activePlan?: Record<string, any> | null;
  openViolations: number;
  schedulesCount: number;
  deliveries: Array<Record<string, any>>;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metricKey?: string | null;
  operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ';
  threshold?: string | number | null;
  reportTemplate?: Pick<ReportTemplate, 'id' | 'name' | 'sourceType'> | null;
  lastCheckedAt?: string | null;
  lastTriggeredAt?: string | null;
}

export interface PlanSet {
  id: string;
  name: string;
  year?: number | null;
  isActive: boolean;
  version: number;
  _count?: { items: number };
}

export interface PlanFactRow {
  id: string;
  metricName: string;
  targetName?: string | null;
  plan: number;
  fact?: number | null;
  delta?: number | null;
  completionPercent?: number | null;
}

export interface QualityRule {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  enabled: boolean;
  config?: Record<string, any>;
}

export interface QualityViolation {
  id: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  managerName?: string | null;
  groupName?: string | null;
  detectedAt: string;
  rule?: QualityRule;
}

export interface ReportSchedule {
  id: string;
  name: string;
  enabled: boolean;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM_CRON';
  timeOfDay: string;
  nextRunAt?: string | null;
  reportTemplate?: Pick<ReportTemplate, 'id' | 'name' | 'sourceType'> | null;
}

