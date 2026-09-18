export type CrmControlResultStatus = 'PASS' | 'FAIL' | 'REVIEW' | 'UNKNOWN' | 'NA';
export type CrmControlEvidenceStatus = 'DISABLED' | 'PENDING' | 'RUNNING' | 'READY' | 'ERROR';
export type CrmControlCaseStatus = 'OPEN' | 'REVIEW' | 'DISPUTED' | 'EXEMPTED' | 'RESOLVED' | 'SUPERSEDED';

export interface CrmControlStageRule {
  allowedTaskTypeIds?: number[];
  deadlineMode?: 'elapsed' | 'business_days' | 'end_of_day' | 'unlimited';
  maxDurationHours?: number;
  maxBusinessDays?: number;
}

export interface CrmControlScope {
  department: 'sales' | 'csm';
  pipelineId: string;
  assignedStageId?: string | null;
  newClientStageId?: string | null;
  baseStageId?: string | null;
  preparedProposalStageId?: string | null;
  priceRequestedStageId?: string | null;
  checkDealAge?: boolean;
  stageRules?: Record<string, CrmControlStageRule>;
}

export interface CrmControlConfig {
  enabled: boolean;
  timeZone: string;
  timeOfDay: string;
  workdays: number[];
  maxDealAge: 'calendar_month' | '30_days';
  excludeBaseFromAge: boolean;
  scopes: CrmControlScope[];
}

export const DEFAULT_CRM_CONTROL_CONFIG: CrmControlConfig = {
  enabled: false,
  timeZone: 'Europe/Moscow',
  timeOfDay: '19:05',
  workdays: [1, 2, 3, 4, 5],
  maxDealAge: 'calendar_month',
  excludeBaseFromAge: true,
  scopes: [],
};

export interface CrmControlRuleResult {
  ruleCode: string;
  ruleName: string;
  status: CrmControlResultStatus;
  message: string;
  subjectId?: string;
  clauses: string[];
  details?: Record<string, unknown>;
}

export interface CrmControlRuleInput {
  deal: {
    id: string; externalId: string; title: string; amount: number;
    createdAt: Date; pipelineId: string; stageId: string;
    responsibleId: string | null; customFields: unknown; raw: unknown;
  };
  tasks: Array<{ id: string; externalId: string; title: string; typeId: number | null; dueAt: Date | null; isCompleted: boolean; raw: unknown }>;
  notes: Array<{ id: string; externalId: string; type: string; text: string | null; createdAt: Date; raw: unknown }>;
  communications?: Array<{ id: string; createdAt: Date; type?: string; text?: string }>;
  stageEnteredAt: Date | null;
  observedAt: Date;
  sourceCompleteness: { deal: boolean; tasks: boolean; notes: boolean; stageHistory: boolean; communications?: boolean };
  config: CrmControlConfig;
  scope: CrmControlScope;
}

export interface CrmControlCounts {
  deals: number;
  failedDeals: number;
  violations: number;
  review: number;
  unknown: number;
  passed: number;
  reviewDeals: number;
  unknownDeals: number;
  checkedDeals: number;
  unresolvedDeals: number;
}

export interface CrmControlDecisionInput {
  action: 'CONFIRM' | 'EXEMPT' | 'DISPUTE';
  reason: string;
  validUntil?: string;
}
