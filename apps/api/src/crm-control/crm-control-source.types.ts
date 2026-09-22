export interface CrmControlWebhookSourceRow {
  id: string;
  connectionId: string;
  entity: string;
  action: string;
  payload: unknown;
  receivedAt: Date;
}

export interface CrmControlSourceAttachment {
  name: string | null;
  type: string | null;
  /** A candidate only: a downloader must validate DNS and every redirect separately. */
  url: string | null;
  urlStatus: 'HTTPS_CANDIDATE' | 'REJECTED';
  identifierHints: { fileUuid: string | null; versionUuid: string | null; urlUuidCandidates: string[] };
  /** Never derived from a URL, file name or the webhook payload hash. */
  contentSha256: null;
}

export interface CrmControlMessageEvidence {
  connectionId: string;
  messageId: string | null;
  sourceRefs: Array<{ inboxId: string; receivedAt: Date }>;
  /** SHA-256 of canonical {entity, action, payload}; not a file hash. */
  rawSha256: string;
  direction: 'outgoing' | 'incoming' | 'unverified';
  actorKind: 'internal' | 'external' | 'bot' | 'unknown';
  authorId: string | null;
  authorUserId: string | null;
  recipientId: string | null;
  occurredAt: Date | null;
  text: string | null;
  origin: string | null;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  binding: {
    kind: 'exact_lead' | 'talk_unresolved' | 'contact_ambiguous' | 'unbound' | 'conflict' | 'other_entity';
    leadExternalId: string | null;
  };
  attachments: CrmControlSourceAttachment[];
  eligibleAsOutgoingEvidence: boolean;
  /** Webhooks record an outgoing event, not confirmed delivery or a complete conversation. */
  deliveryStatus: 'UNVERIFIED';
  issues: string[];
}

export interface CrmControlSourceCursor { receivedAt: Date; id: string }

export interface CrmControlSourceWindowRequest {
  connectionId: string;
  receivedFrom: Date;
  receivedTo: Date;
  pageSize?: number;
  maxRows?: number;
  after?: CrmControlSourceCursor;
}

export interface CrmControlSourceWindow {
  connectionId: string;
  receivedFrom: Date;
  receivedTo: Date;
  rowsRead: number;
  messages: CrmControlMessageEvidence[];
  readAfter: CrmControlSourceCursor | null;
  limitReached: boolean;
  /** True only after reading the entire requested window from its beginning. */
  datasetReadComplete: boolean;
  nextCursor: CrmControlSourceCursor | null;
  sourceCoverage: 'UNVERIFIED';
}

/** A current talk lookup alone does not prove a historical binding. Supply its evidenced interval. */
export interface CrmControlTalkBindingProof {
  connectionId: string;
  talkId: string;
  leadExternalId: string;
  validFrom: Date;
  validTo: Date;
  sourceReference: string;
}

export interface CrmControlDealMessageEvidence {
  message: CrmControlMessageEvidence;
  bindingProof: { kind: 'webhook_entity' | 'talk'; sourceReference: string };
}

export interface CrmControlSourceDealIndex {
  byDeal: Map<string, CrmControlDealMessageEvidence[]>;
  unresolved: CrmControlMessageEvidence[];
  outOfScopeCount: number;
  excludedAfterObservationCount: number;
  sourceCoverage: 'UNVERIFIED';
}
