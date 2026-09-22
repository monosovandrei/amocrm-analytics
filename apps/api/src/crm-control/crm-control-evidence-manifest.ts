export const MAX_EVIDENCE_FRAMES = 8;
export const MAX_EVIDENCE_CAPTURE_MS = 40_000;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const EVIDENCE_HASH = /^[a-f0-9]{64}$/;
export const EVIDENCE_PNG_KEY = /^[a-f0-9]{64}\.png$/;
export const EVIDENCE_MANIFEST_KEY = /^[a-f0-9]{64}\.evidence\.json$/;

export interface CaptureResultReference {
  id: string;
  ruleCode: string;
  subjectId: string;
  status: string;
  details?: unknown;
}

export interface EvidenceBinding {
  observationId: string;
  dealExternalId: string;
  snapshotHash?: string | null;
  observedAt?: string | Date | null;
  results?: CaptureResultReference[];
  snapshot?: unknown;
}

export interface EvidenceFrame {
  id: string;
  label: string;
  kind: 'card' | 'task' | 'feed';
  storageKey: string;
  sha256: string;
  capturedAt: string;
  width: number;
  height: number;
  sourceIds: { tasks: string[]; notes: string[] };
}

export interface EvidenceRuleCoverage {
  resultId: string;
  ruleCode: string;
  subjectId: string;
  status: 'CONTEXT_ONLY' | 'VISIBLE_MATCH' | 'NOT_VISIBLE' | 'SOURCE_CHANGED';
  frameIds: string[];
  reason: string;
}

export interface EvidenceManifest {
  version: 1;
  kind: 'crm-control-evidence';
  observationId: string;
  dealExternalId: string;
  snapshotHash: string | null;
  observedAt: string | null;
  capturedAt: string;
  finishedAt: string;
  truncated: boolean;
  limitation: string;
  frames: EvidenceFrame[];
  coverage: EvidenceRuleCoverage[];
}

export interface VisibleRecord {
  kind: 'task' | 'note';
  domId: string;
  text: string | null;
  completed: boolean | null;
}

export function captureSources(snapshot: unknown) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
  const tasks = Array.isArray(value.tasks) ? value.tasks.flatMap(task => {
    if (!task || typeof task !== 'object') return [];
    const id = String(task.externalId ?? '').replace(/^amo:/, '');
    return /^\d+$/.test(id) ? [{ id, text: typeof task.title === 'string' ? task.title : null,
      completed: typeof task.isCompleted === 'boolean' ? task.isCompleted : null }] : [];
  }) : [];
  const notes = Array.isArray(value.notes) ? value.notes.flatMap(note => {
    if (!note || typeof note !== 'object') return [];
    const id = String(note.externalId ?? '').replace(/^amo:/, '');
    // The current feed uses UUID/ULID IDs. Do not assume that they are numeric API note IDs.
    return /^\d+$/.test(id) ? [{ id }] : [];
  }) : [];
  return { tasks, notes };
}

const normalText = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Match only DOM IDs that genuinely belong to the saved source. Similar text is not an identity match. */
export function frameSourceIds(records: VisibleRecord[], snapshot: unknown): EvidenceFrame['sourceIds'] {
  const sources = captureSources(snapshot);
  return {
    tasks: [...new Set(records.filter(record => record.kind === 'task' && sources.tasks.some(task => task.id === record.domId)).map(record => record.domId))],
    notes: [...new Set(records.filter(record => record.kind === 'note' && sources.notes.some(note => note.id === record.domId)).map(record => record.domId))],
  };
}

export function buildRuleCoverage(binding: EvidenceBinding, frames: EvidenceFrame[], visible: Map<string, VisibleRecord[]>): EvidenceRuleCoverage[] {
  const tasks = captureSources(binding.snapshot).tasks;
  return (binding.results ?? []).filter(result => !['PASS', 'NA'].includes(result.status)).map(result => {
    const taskRule = ['task_deadline', 'task_type', 'task_text', 'task_stage_deadline'].includes(result.ruleCode);
    const taskId = result.subjectId.replace(/^amo:/, '');
    const matchingFrames = taskRule ? frames.filter(frame => frame.sourceIds.tasks.includes(taskId))
      .sort((a, b) => Number(b.kind === 'task') - Number(a.kind === 'task')) : frames;
    const frameIds = matchingFrames.map(frame => frame.id);
    const base = { resultId: result.id, ruleCode: result.ruleCode, subjectId: result.subjectId, frameIds };
    if (taskRule && !matchingFrames.length) return { ...base, status: 'NOT_VISIBLE' as const,
      reason: 'Задача с сохранённым ID не попала в доступные кадры. Это не доказывает её отсутствие в amoCRM.' };
    if (taskRule) {
      const before = tasks.find(task => task.id === taskId);
      const records = matchingFrames.flatMap(frame => visible.get(frame.id) ?? []).filter(record => record.kind === 'task' && record.domId === taskId);
      const changed = before && records.some(record => (record.completed !== null && before.completed !== null && record.completed !== before.completed)
        || (record.text !== null && before.text !== null && normalText(record.text) !== normalText(before.text)));
      if (changed) return { ...base, status: 'SOURCE_CHANGED' as const,
        reason: 'На момент съёмки текст или состояние задачи с этим ID отличается от сохранённой проверки. Кадры показывают новое состояние.' };
      if (result.ruleCode === 'task_text' && before && records.some(record => record.text !== null && before.text !== null
        && normalText(record.text) === normalText(before.text) && record.completed !== null && before.completed !== null && record.completed === before.completed)) {
        return { ...base, status: 'VISIBLE_MATCH' as const,
          reason: 'В кадре видны задача с тем же ID, её текст и состояние, совпавшие с сохранёнными данными. Смысл следующего действия этим совпадением не подтверждается.' };
      }
      return { ...base, status: 'CONTEXT_ONLY' as const,
        reason: 'В кадре видна задача с сохранённым ID. Совпадение её срока и типа с прошлой проверкой не установлено; используйте сохранённые факты.' };
    }
    return { ...base, status: 'CONTEXT_ONLY' as const, reason: result.ruleCode === 'task_count' || result.ruleCode === 'proposal_note'
      ? 'Кадры показывают доступные поля и участки ленты на момент съёмки. Они не доказывают отсутствие скрытых задач или примечаний.'
      : 'Кадры показывают контекст карточки на момент съёмки. Исторический срок, отправка предложения и содержимое скрытых файлов ими не подтверждены.' };
  });
}

/** Reject malformed/cross-observation references before serving any frame. */
export function validateEvidenceManifest(value: unknown, binding: EvidenceBinding): EvidenceManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid evidence manifest');
  const item = value as EvidenceManifest;
  const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (item.version !== 1 || item.kind !== 'crm-control-evidence' || item.observationId !== binding.observationId
    || item.dealExternalId !== binding.dealExternalId || item.snapshotHash !== (binding.snapshotHash ?? null)
    || item.observedAt !== (binding.observedAt ? new Date(binding.observedAt).toISOString() : null)
    || !iso(item.capturedAt) || !iso(item.finishedAt) || Date.parse(item.finishedAt) < Date.parse(item.capturedAt)
    || typeof item.truncated !== 'boolean' || typeof item.limitation !== 'string' || item.limitation.length > 2000
    || !Array.isArray(item.frames) || item.frames.length < 1 || item.frames.length > MAX_EVIDENCE_FRAMES || !Array.isArray(item.coverage)) throw new Error('Invalid evidence manifest');
  const ids = new Set<string>();
  const sources = captureSources(binding.snapshot);
  for (const frame of item.frames) {
    if (!frame || !/^[a-z0-9-]{1,80}$/.test(frame.id) || ids.has(frame.id) || !['card', 'task', 'feed'].includes(frame.kind)
      || typeof frame.label !== 'string' || frame.label.length > 160 || !EVIDENCE_PNG_KEY.test(frame.storageKey)
      || !EVIDENCE_HASH.test(frame.sha256) || frame.storageKey !== `${frame.sha256}.png` || !iso(frame.capturedAt)
      || Date.parse(frame.capturedAt) < Date.parse(item.capturedAt) || Date.parse(frame.capturedAt) > Date.parse(item.finishedAt)
      || !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 4000
      || !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 4000
      || !frame.sourceIds || !Array.isArray(frame.sourceIds.tasks) || !Array.isArray(frame.sourceIds.notes)
      || frame.sourceIds.tasks.some(id => !sources.tasks.some(task => task.id === id))
      || frame.sourceIds.notes.some(id => !sources.notes.some(note => note.id === id))) throw new Error('Invalid evidence frame');
    ids.add(frame.id);
  }
  const resultIds = new Set<string>();
  const expected = (binding.results ?? []).filter(result => !['PASS', 'NA'].includes(result.status));
  if (item.coverage.length !== expected.length) throw new Error('Invalid evidence coverage');
  for (const coverage of item.coverage) {
    const result = expected.find(result => result.id === coverage.resultId);
    if (!result || resultIds.has(coverage.resultId) || coverage.ruleCode !== result.ruleCode || coverage.subjectId !== result.subjectId
      || !['CONTEXT_ONLY', 'VISIBLE_MATCH', 'NOT_VISIBLE', 'SOURCE_CHANGED'].includes(coverage.status)
      || !Array.isArray(coverage.frameIds) || new Set(coverage.frameIds).size !== coverage.frameIds.length || coverage.frameIds.some(id => !ids.has(id))
      || typeof coverage.reason !== 'string' || !coverage.reason || coverage.reason.length > 2000) throw new Error('Invalid evidence coverage');
    if (['VISIBLE_MATCH', 'SOURCE_CHANGED'].includes(coverage.status) && (!coverage.frameIds.length
      || (coverage.status === 'VISIBLE_MATCH' && coverage.ruleCode !== 'task_text')
      || !coverage.frameIds.some(id => item.frames.find(frame => frame.id === id)?.sourceIds.tasks.includes(result.subjectId.replace(/^amo:/, ''))))) {
      throw new Error('Invalid source match');
    }
    resultIds.add(coverage.resultId);
  }
  return item;
}

export function publicEvidenceManifest(manifest: EvidenceManifest, evidenceId: string) {
  return { version: manifest.version, observedAt: manifest.observedAt, capturedAt: manifest.capturedAt, finishedAt: manifest.finishedAt,
    truncated: manifest.truncated, limitation: manifest.limitation, coverage: manifest.coverage.map(item => ({
      resultId: item.resultId, ruleCode: item.ruleCode, subjectId: item.subjectId, status: item.status, frameIds: [...item.frameIds], reason: item.reason })),
    frames: manifest.frames.map(frame => ({ id: frame.id, label: frame.label, kind: frame.kind, sha256: frame.sha256,
      capturedAt: frame.capturedAt, width: frame.width, height: frame.height,
      sourceIds: { tasks: [...frame.sourceIds.tasks], notes: [...frame.sourceIds.notes] },
      downloadUrl: `/crm-control/evidence/${encodeURIComponent(evidenceId)}/frames/${encodeURIComponent(frame.id)}/file` })) };
}
