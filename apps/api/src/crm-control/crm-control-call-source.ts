import { createHash } from 'node:crypto';

export interface CrmControlCallObservation {
  /** Internal persisted observation, loaded by the server. Never accept this DTO from an HTTP caller. */
  id: string; dealId: string; dealExternalId: string; managerId: string | null;
  observedAt: Date; snapshotHash: string; snapshot: unknown;
}
/** Private worker input. recordingUrl must never be returned by a public controller or written to logs. */
export interface CrmControlCallSource {
  status: 'BOUND' | 'UNBOUND' | 'INVALID'; issues: string[];
  observationId: string; dealId: string; ownerId: string | null; snapshotHash: string;
  noteId: string | null; providerCallId: string | null; sourceHash: string;
  sourceIdentityVersion: 'call-source-v1'; sourceIdentityHash: string;
  direction: 'incoming' | 'outgoing'; recordedAt: string | null; recordedAtSource: 'note.created_at';
  durationSeconds: number | null; recordingUrl: string | null; recordingUrlHash: string | null;
  binding: 'DIRECT_LEAD_NOTE' | 'UNVERIFIED'; speakerRoles: 'UNKNOWN'; transcriptQuality: 'NOT_PROCESSED';
}
export interface CrmControlCallSources { sources: CrmControlCallSource[]; issues: string[]; communicationsComplete: false }
const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as any : null;
const numericId = (value: unknown): string | null => (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const callId = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(value) ? value : numericId(value);
const timestamp = (value: unknown): number | null => {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 253402300799 ? seconds * 1000 : null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = object(value);
  return record ? `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** JSONB may reorder keys. The old snapshotHash is a persisted reference, not a digest of this reserialized object. */
export function crmControlCallSourceIdentity(source: Pick<CrmControlCallSource, 'observationId' | 'dealId' | 'ownerId' | 'snapshotHash'
  | 'noteId' | 'sourceHash' | 'recordingUrlHash'>): string {
  return hash(canonical({ version: 'call-source-v1', observationId: source.observationId, dealId: source.dealId,
    ownerId: source.ownerId, snapshotHash: source.snapshotHash, noteId: source.noteId,
    sourceHash: source.sourceHash, recordingUrlHash: source.recordingUrlHash }));
}
function candidateUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  // Retain the exact frozen string. The provider policy checks traversal and hashes before any URL normalization.
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? value : null; }
  catch { return null; }
}

/** Only server-loaded snapshot.notes from /leads/:id/notes establish binding. Never merge contact or browser-related notes here.
 *  Source identities are verified again against a freshly loaded observation before a delayed job executes.
 *  A hash is not an authorization mechanism; the caller owns DB lookup and observation ACL. */
export function normalizeCrmControlCallSources(observation: CrmControlCallObservation): CrmControlCallSources {
  const output: CrmControlCallSources = { sources: [], issues: [], communicationsComplete: false };
  const snapshot = object(observation?.snapshot), deal = object(snapshot?.deal);
  const observed = observation?.observedAt instanceof Date ? observation.observedAt.getTime() : NaN;
  if (!snapshot || !deal || !HASH.test(observation.snapshotHash)
    || !observation.id || !observation.managerId || deal.id !== observation.dealId || deal.externalId !== observation.dealExternalId
    || deal.responsibleId !== observation.managerId || !numericId(observation.dealExternalId) || !Number.isFinite(observed)
    || Date.parse(snapshot.observedAt) !== observed || snapshot.sourceCompleteness?.deal !== true || !Array.isArray(snapshot.notes)) {
    output.issues.push('CALL_SNAPSHOT_UNVERIFIED'); return output;
  }
  const created = Date.parse(deal.createdAt);
  if (!Number.isFinite(created) || created > observed) { output.issues.push('CALL_SNAPSHOT_UNVERIFIED'); return output; }
  const byId = new Map<string, CrmControlCallSource>();
  for (const note of snapshot.notes) {
    const raw = object(note?.raw);
    if (!raw || !['call_in', 'call_out'].includes(raw.note_type)) continue;
    const params = object(raw.params), sourceHash = hash(canonical(raw)), noteId = numericId(raw.id);
    const issues: string[] = [];
    const at = timestamp(raw.created_at), updated = raw.updated_at == null ? at : timestamp(raw.updated_at);
    if (!noteId || (note.externalId != null && String(note.externalId) !== noteId) || (note.type != null && note.type !== raw.note_type)) issues.push('CALL_NOTE_IDENTITY_CONFLICT');
    if (at === null || at < created || at > observed || updated === null || updated < at || updated > observed) issues.push('CALL_NOTE_TIME_UNVERIFIED');
    const entityId = numericId(raw.entity_id), kind = raw.entity_type;
    const direct = entityId === observation.dealExternalId && (kind == null || ['lead', 'leads', 2, '2'].includes(kind));
    if (!direct) issues.push('CALL_DEAL_BINDING_UNVERIFIED');
    const uniq = params?.uniq == null ? null : callId(params.uniq), providerId = params?.call_id == null ? null : callId(params.call_id);
    if ((params?.uniq != null && !uniq) || (params?.call_id != null && !providerId) || (uniq && providerId && uniq !== providerId)) issues.push('CALL_PROVIDER_ID_UNVERIFIED');
    const seconds = typeof params?.duration === 'number' ? params.duration
      : typeof params?.duration === 'string' && /^\d{1,8}$/.test(params.duration) ? Number(params.duration) : NaN;
    const duration = Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
    const recordingUrl = candidateUrl(params?.link);
    if (!recordingUrl) issues.push('CALL_RECORDING_URL_UNAVAILABLE');
    const invalid = issues.some(code => ['CALL_NOTE_IDENTITY_CONFLICT', 'CALL_NOTE_TIME_UNVERIFIED', 'CALL_PROVIDER_ID_UNVERIFIED'].includes(code));
    const source: CrmControlCallSource = { status: invalid ? 'INVALID' : direct ? 'BOUND' : 'UNBOUND', issues,
      observationId: observation.id, dealId: observation.dealId, ownerId: observation.managerId, snapshotHash: observation.snapshotHash,
      noteId, providerCallId: uniq ?? providerId, sourceHash, sourceIdentityVersion: 'call-source-v1', sourceIdentityHash: '',
      direction: raw.note_type === 'call_in' ? 'incoming' : 'outgoing',
      recordedAt: at === null ? null : new Date(at).toISOString(), recordedAtSource: 'note.created_at', durationSeconds: duration,
      recordingUrl: !invalid && direct ? recordingUrl : null,
      recordingUrlHash: !invalid && direct && recordingUrl ? hash(recordingUrl) : null,
      binding: !invalid && direct ? 'DIRECT_LEAD_NOTE' : 'UNVERIFIED',
      speakerRoles: 'UNKNOWN', transcriptQuality: 'NOT_PROCESSED' };
    source.sourceIdentityHash = crmControlCallSourceIdentity(source);
    const key = noteId ?? `invalid:${sourceHash}`, previous = byId.get(key);
    if (previous) {
      if (previous.sourceHash !== sourceHash) {
        previous.status = 'INVALID'; previous.binding = 'UNVERIFIED'; previous.recordingUrl = null; previous.recordingUrlHash = null;
        previous.sourceIdentityHash = crmControlCallSourceIdentity(previous);
        if (!previous.issues.includes('CALL_NOTE_IDENTITY_CONFLICT')) previous.issues.push('CALL_NOTE_IDENTITY_CONFLICT');
      }
    } else byId.set(key, source);
  }
  output.sources = [...byId.values()];
  return output;
}
