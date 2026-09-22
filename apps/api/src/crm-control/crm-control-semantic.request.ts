import { createHash } from 'node:crypto';
import { CrmControlSemanticRequest, CrmControlSemanticSource, crmControlSemanticTextHash } from './crm-control-semantic.validation';

export interface CrmControlSemanticObservation {
  id: string; dealId: string; managerId: string | null; observedAt: Date; stageName: string;
  snapshot: unknown; snapshotHash: string; run: { config: unknown };
}
export interface CrmControlSemanticRule {
  id: string; ruleCode: string; subjectId: string; status: string; details: unknown;
}
const CHECKS: Record<string, CrmControlSemanticRequest['check']> = { task_text: 'task_action', proposal_note: 'proposal_note',
  task_stage_deadline: 'deadline_agreement', stage_duration: 'deadline_agreement', price_requested_duration: 'price_delay' };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const iso = (value: unknown): string | null => {
  const date = typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : value instanceof Date ? value : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** The only constructor of trusted model inputs: every source comes from one immutable observation. */
export function buildCrmControlSemanticRequest(observation: CrmControlSemanticObservation, result: CrmControlSemanticRule): CrmControlSemanticRequest | null {
  const check = CHECKS[result.ruleCode];
  const snapshot = record(observation.snapshot), details = record(result.details), config = record(observation.run.config);
  if (!check || !observation.managerId || !['REVIEW','UNKNOWN'].includes(result.status) || details.awaitingDayEnd
    || snapshot.sourceCompleteness?.deal !== true || typeof config.timeZone !== 'string') return null;
  if (['deadline_agreement','price_delay'].includes(check) && (details.deadlineMode === 'end_of_day' || !iso(details.maximumDueAt))) return null;
  const observedAt = observation.observedAt.toISOString();
  const stageEnteredAt = iso(snapshot.stageEnteredAt);
  const responsibleExternalId = String(snapshot.deal?.raw?.responsible_user_id ?? '');
  const sources: CrmControlSemanticSource[] = [];
  let notesDated = true, communicationsDated = true;
  const make = (id: string, text: string, kind: CrmControlSemanticSource['kind'], createdAt: string | null,
    actor: CrmControlSemanticSource['actor'], actorId: string | null, direction: CrmControlSemanticSource['direction'], subjectId: string | null = null,
    assignedManagerId?: string | null): CrmControlSemanticSource => ({ id, text, sourceHash: crmControlSemanticTextHash(text), kind,
    createdAt, actor, actorId, direction, subjectId, ...(kind === 'task' ? { assignedManagerId: assignedManagerId ?? null } : {}),
    dealId: observation.dealId, ownerId: observation.managerId! });
  if (check === 'task_action') {
    const task = (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).find((item: any) => String(item.externalId || item.id) === result.subjectId && !item.isCompleted);
    if (!task) return null;
    const text = typeof task.raw?.text === 'string' ? task.raw.text : typeof task.title === 'string' ? task.title : '';
    if (!text.trim()) return null; // Empty text is already a deterministic failure in the rule engine.
    const author = task.raw?.created_by == null ? null : String(task.raw.created_by);
    const assigned = String(task.raw?.responsible_user_id ?? '') === responsibleExternalId && responsibleExternalId ? observation.managerId : null;
    if (!assigned) return null;
    sources.push(make(`task:${result.subjectId}`, text, 'task', iso(task.raw?.created_at),
      author === responsibleExternalId ? 'manager' : 'unknown', author, 'internal', result.subjectId, assigned));
  } else {
    if (!stageEnteredAt) return null;
    const withinWindow = (date: string | null) => !!date && date >= stageEnteredAt && date <= observedAt;
    for (const note of Array.isArray(snapshot.notes) ? snapshot.notes : []) {
      if (note.type === 'common' && typeof note.text === 'string' && note.text.trim() && !iso(note.createdAt)) notesDated = false;
      if (note.type !== 'common' || typeof note.text !== 'string' || !note.text.trim() || !withinWindow(iso(note.createdAt))) continue;
      const author = note.raw?.created_by == null ? null : String(note.raw.created_by);
      sources.push(make(`note:${note.externalId || note.id}`, note.text, 'manager_note', iso(note.createdAt),
        author && author === responsibleExternalId ? 'manager' : 'unknown', author, 'internal'));
    }
    if (check !== 'proposal_note') {
      const contacts = new Set((snapshot.deal?.raw?._embedded?.contacts ?? []).map((item: any) => String(item.id)));
      for (const entry of snapshot.communicationSources?.messages ?? []) {
        const message = entry.message;
        if (message && typeof message.text === 'string' && message.text.trim() && !iso(message.occurredAt)) communicationsDated = false;
        if (!message?.messageId || typeof message.text !== 'string' || !message.text.trim() || !withinWindow(iso(message.occurredAt))) continue;
        // An arbitrary external participant is not certified as this customer's speaker.
        const customer = message.direction === 'incoming' && message.actorKind === 'external'
          && message.authorId && message.contactId && contacts.has(String(message.contactId));
        const manager = message.direction === 'outgoing' && message.actorKind === 'internal'
          && String(message.authorUserId ?? '') === responsibleExternalId && responsibleExternalId;
        sources.push(make(`message:${message.messageId}`, message.text, customer ? 'customer_message' : 'message', iso(message.occurredAt),
          customer ? 'customer' : manager ? 'manager' : message.actorKind === 'bot' ? 'bot' : 'unknown',
          message.authorUserId || message.authorId || null, ['incoming','outgoing'].includes(message.direction) ? message.direction : 'unknown'));
      }
    }
  }
  const request: CrmControlSemanticRequest = { schemaVersion: 1, requestId: createHash('sha256').update(`${observation.id}:${result.id}:${observation.snapshotHash}`).digest('hex'),
    check, dealId: observation.dealId, ownerId: observation.managerId, subjectId: result.subjectId || null,
    observedAt, stageEnteredAt, timeZone: config.timeZone, stageName: observation.stageName,
    taskDueAt: iso(details.dueAt), maxDueAt: iso(details.maximumDueAt),
    coverage: { tasks: snapshot.sourceCompleteness?.tasks === true, notes: snapshot.sourceCompleteness?.notes === true && notesDated,
      communications: snapshot.sourceCompleteness?.communications === true && communicationsDated }, sources };
  return request;
}
