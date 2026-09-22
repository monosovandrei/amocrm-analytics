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
  capabilities: { screenshots: boolean; communications: boolean; proposalFiles: boolean; localAnalysis?: boolean };
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
  analysis?: { queued: number; running: number; completed: number; failed: number; unresolved: number; preparing: boolean };
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
  analysis?: { id: string; status: string; outcome: 'PASS' | 'FAIL' | null; message: string; completedAt: string | null; attempts: number } | null;
  review?: {
    allowed: boolean;
    expectedDecisionId: string | null;
    guidance: string;
    current: { decisionId: string; outcome: 'PASS' | 'FAIL' | 'NA'; reason: string; reviewedBy: string; reviewedAt: string } | null;
  };
}

export interface ControlOfferCitation {
  quote: string;
  locator: { kind: 'pdf'; page: number } | { kind: 'docx'; part: string; path: string }
    | { kind: 'xlsx'; sheet: string; cell: string } | { kind: 'message' };
}

export interface ControlOfferAnalysis {
  version: 1;
  historyStatus: 'VERIFIED_COMPLETE' | 'UNVERIFIED';
  reasons: string[];
  evidence?: ControlOfferCitation[];
  candidates: Array<{
    status: 'CANDIDATE_ONLY';
    source: 'field' | 'sent';
    sourceId: string;
    sentAt: string | null;
    headingEvidence: ControlOfferCitation[];
    amount: { decimal: string; currency: string; evidence: ControlOfferCitation[] } | null;
  }>;
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

export interface ControlEvidenceManifest {
  version: 0 | 1;
  observedAt: string | null;
  capturedAt: string | null;
  finishedAt?: string;
  truncated?: boolean;
  limitation: string;
  frames: Array<{ id: string; label: string; capturedAt: string | null; downloadUrl: string;
    kind?: 'card' | 'task' | 'feed'; width?: number; height?: number }>;
  coverage: Array<{ resultId: string; ruleCode: string; subjectId: string;
    status: 'CONTEXT_ONLY' | 'VISIBLE_MATCH' | 'NOT_VISIBLE' | 'SOURCE_CHANGED'; frameIds: string[]; reason: string }>;
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
  documents?: Array<{ sha256: string; size: number; capturedAt: string; label: string; source: 'field' | 'sent'; downloadUrl: string }>;
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
