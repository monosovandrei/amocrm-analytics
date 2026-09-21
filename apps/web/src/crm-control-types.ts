export type ControlDepartment = 'sales' | 'csm';
export type ControlResultStatus = 'PASS' | 'FAIL' | 'REVIEW' | 'UNKNOWN' | 'NA';
export type ControlCaseStatus = 'OPEN' | 'REVIEW' | 'DISPUTED' | 'EXEMPTED' | 'RESOLVED' | 'SUPERSEDED';
export type ControlDeadlineMode = 'elapsed' | 'business_days' | 'end_of_day' | 'unlimited';

export interface ControlStageRule {
  allowedTaskTypeIds?: number[];
  deadlineMode?: ControlDeadlineMode;
  maxDurationHours?: number;
  maxBusinessDays?: number;
}

export interface ControlScope {
  department: ControlDepartment;
  pipelineId: string;
  checkDealAge?: boolean;
  assignedStageId?: string | null;
  newClientStageId?: string | null;
  baseStageId?: string | null;
  preparedProposalStageId?: string | null;
  priceRequestedStageId?: string | null;
  stageRules?: Record<string, ControlStageRule>;
}

export interface ControlConfig {
  enabled: boolean;
  timeZone: string;
  timeOfDay: string;
  workdays: number[];
  maxDealAge: 'calendar_month' | '30_days';
  excludeBaseFromAge: boolean;
  scopes: ControlScope[];
}

export interface ControlCounts {
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

export interface ControlSettings {
  config: ControlConfig;
  version: number;
  canManage: boolean;
  canReview: boolean;
  canDispute: boolean;
  capabilities: { screenshots: boolean; communications: boolean; proposalFiles: boolean };
  options: {
    pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; isWon: boolean; isLost: boolean }> }>;
    taskTypes: Array<{ id: number; name: string }>;
  };
  suggestedScopes: ControlScope[];
  configurationIssues: string[];
  ruleCatalog: Array<{ code: string; name: string; clauses: string[]; mode: 'automatic' | 'review' }>;
}

export interface ControlRun {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'ERROR';
  trigger: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  sourceSyncAt: string | null;
  error: string | null;
  counts: ControlCounts;
  completion?: {
    status: 'CHECKED' | 'UNCHECKED';
    remainingResults: number;
    remainingDeals: number;
    reasons: Array<{ code: string; message: string; count?: number }>;
    canRecheck: boolean;
  };
}

export interface ControlManager extends ControlCounts {
  managerId: string | null;
  managerName: string | null;
  groupName: string | null;
  department: ControlDepartment;
}

export interface ControlRunDetail {
  run: ControlRun;
  counts: ControlCounts;
  managers: ControlManager[];
  configurationIssues: string[];
  ruleBreakdown?: ControlRuleBreakdown[];
}

export interface ControlRuleBreakdown {
  ruleCode: string;
  ruleName: string;
  failedDeals: number;
  reviewDeals: number;
  unknownDeals: number;
  byManager: Array<{
    managerId: string | null;
    department: ControlDepartment;
    failedDeals: number;
    reviewDeals: number;
    unknownDeals: number;
  }>;
}

export interface ControlResult {
  id: string;
  ruleCode: string;
  ruleName: string;
  status: ControlResultStatus;
  effectiveStatus?: ControlResultStatus;
  message: string;
  subjectId?: string;
  clauses: string[];
  details?: Record<string, unknown>;
  caseId?: string | null;
  caseStatus?: ControlCaseStatus | null;
  review?: {
    allowed: boolean;
    expectedDecisionId: string | null;
    guidance: string;
    current: { decisionId: string; outcome: 'PASS' | 'FAIL' | 'NA'; reason: string; reviewedBy: string; reviewedAt: string } | null;
  };
}

export interface ControlEvidence {
  id: string;
  status: 'DISABLED' | 'PENDING' | 'RUNNING' | 'READY' | 'ERROR';
  capturedAt: string | null;
  error: string | null;
  sourceUrl?: string;
  contentType?: string;
  downloadUrl?: string;
  coverage?: string;
}

export interface ControlObservation {
  id: string;
  dealExternalId: string;
  dealTitle: string;
  dealUrl: string;
  managerId: string | null;
  managerName: string;
  groupName: string;
  department: ControlDepartment;
  pipelineName: string;
  stageName: string;
  observedAt: string;
  counts: ControlCounts;
  results: ControlResult[];
  evidence: ControlEvidence[];
}

export interface ControlDecision {
  id: string;
  action: 'CONFIRM' | 'EXEMPT' | 'DISPUTE' | 'VERIFY_PASS' | 'VERIFY_FAIL' | 'VERIFY_NA';
  reason: string;
  validUntil?: string | null;
  createdAt: string;
  actorName?: string;
}

export interface ControlObservationDetail extends ControlObservation {
  snapshot: Record<string, unknown>;
  cases: Array<{
    id: string;
    ruleCode: string;
    status: ControlCaseStatus;
    firstDetectedAt: string;
    lastDetectedAt: string;
    resolvedAt: string | null;
    resolutionReason?: string | null;
    decisions: ControlDecision[];
  }>;
  history: Array<{ id: string; runId: string; observedAt: string; counts: ControlCounts }>;
}

export interface ControlPage<T> {
  items: T[];
  nextCursor: string | null;
}
