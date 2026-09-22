import { buildRuleCoverage, EvidenceBinding, EvidenceFrame, EvidenceManifest, frameSourceIds, publicEvidenceManifest, validateEvidenceManifest } from './crm-control-evidence-manifest';

const time = '2026-09-22T10:00:00.000Z';
const hash = 'a'.repeat(64);
const binding: EvidenceBinding = { observationId: 'observation', dealExternalId: '123', snapshotHash: 'b'.repeat(64), observedAt: time,
  snapshot: { tasks: [{ externalId: '7', title: 'Позвонить клиенту', isCompleted: false }], notes: [{ externalId: '9' }] },
  results: [{ id: 'r1', ruleCode: 'task_text', subjectId: '7', status: 'REVIEW' },
    { id: 'r2', ruleCode: 'task_deadline', subjectId: '7', status: 'FAIL' },
    { id: 'r3', ruleCode: 'proposal_note', subjectId: '', status: 'FAIL' }] };
const frame: EvidenceFrame = { id: 'task-7', label: 'Задача', kind: 'task', capturedAt: time, width: 1600, height: 1200,
  storageKey: `${hash}.png`, sha256: hash, sourceIds: { tasks: ['7'], notes: [] } };
function fixture(): EvidenceManifest {
  return { version: 1, kind: 'crm-control-evidence', observationId: binding.observationId, dealExternalId: '123', snapshotHash: binding.snapshotHash!,
    observedAt: time, capturedAt: time, finishedAt: time, truncated: true, limitation: 'Только видимые фрагменты', frames: [structuredClone(frame)],
    coverage: buildRuleCoverage(binding, [frame], new Map([['task-7', [{ kind: 'task', domId: '7', text: 'Позвонить клиенту', completed: false }]]])) };
}

describe('CRM evidence frame manifest', () => {
  it('maps only actual IDs from the saved source; a note ULID is not an API note ID', () => {
    expect(frameSourceIds([{ kind: 'task', domId: '7', text: null, completed: false }, { kind: 'task', domId: '99', text: null, completed: false },
      { kind: 'note', domId: '01m31kaxrsx15kdtj7fwdw2m0f', text: null, completed: null }], binding.snapshot)).toEqual({ tasks: ['7'], notes: [] });
  });

  it('matches only visible text/state and never upgrades task deadlines or absence of notes to proven', () => {
    const manifest = fixture();
    expect(manifest.coverage.map(item => item.status)).toEqual(['VISIBLE_MATCH', 'CONTEXT_ONLY', 'CONTEXT_ONLY']);
    expect(manifest.coverage[0].reason).toContain('Смысл');
    expect(manifest.coverage[2].reason).toContain('не доказывают отсутствие');
    expect(validateEvidenceManifest(manifest, binding)).toBe(manifest);
  });

  it('separates changed and unseen tasks from a snapshot match', () => {
    const changed = buildRuleCoverage(binding, [frame], new Map([['task-7', [{ kind: 'task', domId: '7', text: 'Новый текст', completed: true }]]]));
    expect(changed[0].status).toBe('SOURCE_CHANGED');
    expect(changed[1].status).toBe('SOURCE_CHANGED');
    const missing = buildRuleCoverage(binding, [{ ...frame, sourceIds: { tasks: [], notes: [] } }], new Map());
    expect(missing[0]).toMatchObject({ status: 'NOT_VISIBLE', frameIds: [] });
    expect(missing[0].reason).toContain('не доказывает');
  });

  it.each(['observation', 'deal', 'snapshot', 'time', 'foreign-result', 'foreign-source', 'traversal', 'hash', 'duplicate', 'unknown-frame', 'oversized', 'unbound-match', 'deadline-match'])('rejects a broken binding or frame allowlist: %s', kind => {
    const manifest = fixture();
    if (kind === 'observation') manifest.observationId = 'other';
    if (kind === 'deal') manifest.dealExternalId = '999';
    if (kind === 'snapshot') manifest.snapshotHash = 'c'.repeat(64);
    if (kind === 'time') manifest.observedAt = null;
    if (kind === 'foreign-result') manifest.coverage[0].resultId = 'foreign';
    if (kind === 'foreign-source') manifest.frames[0].sourceIds.tasks = ['99'];
    if (kind === 'traversal') manifest.frames[0].storageKey = '../../session.json';
    if (kind === 'hash') manifest.frames[0].sha256 = 'c'.repeat(64);
    if (kind === 'duplicate') manifest.frames.push(manifest.frames[0]);
    if (kind === 'unknown-frame') manifest.coverage[0].frameIds = ['other'];
    if (kind === 'oversized') manifest.frames[0].height = 10000;
    if (kind === 'unbound-match') manifest.coverage[0].frameIds = [];
    if (kind === 'deadline-match') manifest.coverage[1].status = 'VISIBLE_MATCH';
    expect(() => validateEvidenceManifest(manifest, binding)).toThrow();
  });

  it('publishes explicit fields and authorized frame URLs, never local keys or extra private fields', () => {
    const manifest = fixture();
    Object.assign(manifest.frames[0], { cookie: 'secret', directory: 'private' });
    const output = publicEvidenceManifest(manifest, 'evidence');
    expect(output.frames[0].downloadUrl).toBe('/crm-control/evidence/evidence/frames/task-7/file');
    expect(JSON.stringify(output)).not.toContain('storageKey');
    expect(JSON.stringify(output)).not.toContain('secret');
    expect(JSON.stringify(output)).not.toContain('private');
  });
});
