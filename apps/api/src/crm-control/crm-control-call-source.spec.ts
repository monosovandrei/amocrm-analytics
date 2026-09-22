import { createHash } from 'node:crypto';
import { normalizeCrmControlCallSources } from './crm-control-call-source';

const time = (value: string) => Date.parse(value) / 1000;
function fixture() {
  const raw = { id: 700, entity_id: 100, note_type: 'call_out', created_at: time('2026-09-22T12:00:00Z'),
    updated_at: time('2026-09-22T12:00:00Z'), created_by: 55,
    params: { uniq: 'provider-call-1', duration: 120, link: 'https://userapi.skytel.spb.ru/synthetic.recording:one.mp3' } };
  const snapshot: any = { observedAt: '2026-09-22T16:05:00Z', sourceCompleteness: { deal: true, notes: true },
    deal: { id: 'amo:100', externalId: '100', responsibleId: 'manager-1', createdAt: '2026-09-01T10:00:00Z' },
    notes: [{ externalId: '700', type: 'call_out', raw }] };
  const observation = { id: 'observation-1', dealId: 'amo:100', dealExternalId: '100', managerId: 'manager-1',
    observedAt: new Date(snapshot.observedAt), snapshot, snapshotHash: '' };
  const seal = () => { observation.snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); return observation; };
  return { snapshot, raw, observation, run: () => normalizeCrmControlCallSources(seal()), seal };
}

describe('frozen call source normalization', () => {
  it('binds a direct lead call, retains immutable source hashes and never assigns a speaker from note author', () => {
    const f = fixture(), output = f.run();
    expect(output).toMatchObject({ communicationsComplete: false, issues: [], sources: [{ status: 'BOUND',
      binding: 'DIRECT_LEAD_NOTE', noteId: '700', providerCallId: 'provider-call-1', recordedAtSource: 'note.created_at',
      recordedAt: '2026-09-22T12:00:00.000Z', direction: 'outgoing', speakerRoles: 'UNKNOWN', transcriptQuality: 'NOT_PROCESSED' }] });
    expect(output.sources[0].snapshotHash).toBe(f.observation.snapshotHash);
    expect(output.sources[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.sources[0].sourceIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.sources[0].recordingUrlHash).toBe(createHash('sha256').update(f.raw.params.link).digest('hex'));
  });
  it.each([['contacts', 100], ['contacts', 999], ['leads', 999], [1, 100], [undefined, 999]])(
    'does not bind related/wrong entity type %s and id %s even when text names this deal', (entity_type, entity_id) => {
      const f = fixture(); Object.assign(f.raw, { entity_type, entity_id });
      Object.assign(f.raw.params, { call_result: 'Единственная сделка 100, клиент согласен', lead_id: 100 });
      expect(f.run().sources[0]).toMatchObject({ status: 'UNBOUND', binding: 'UNVERIFIED', recordingUrl: null, speakerRoles: 'UNKNOWN' });
    });
  it('changes the canonical source identity when source content changes without rewriting the old snapshot reference', () => {
    const f = fixture(), original = f.run().sources[0], persistedHash = f.observation.snapshotHash;
    f.raw.params.duration = 180;
    const changed = normalizeCrmControlCallSources(f.observation).sources[0];
    expect(changed.sourceHash).not.toBe(original.sourceHash); expect(changed.sourceIdentityHash).not.toBe(original.sourceIdentityHash);
    expect(changed.snapshotHash).toBe(persistedHash); expect(f.observation.snapshotHash).toBe(persistedHash);
  });
  it('refuses changed owner, malformed persisted reference and incomplete deal read', () => {
    const f = fixture(); f.seal(); f.observation.snapshotHash = 'not-a-hash';
    expect(normalizeCrmControlCallSources(f.observation).sources).toEqual([]);
    f.snapshot.deal.responsibleId = 'other'; expect(f.run().sources).toEqual([]);
    f.snapshot.deal.responsibleId = 'manager-1'; f.snapshot.sourceCompleteness.deal = false; expect(f.run().sources).toEqual([]);
  });
  it('survives JSONB-style recursive key reordering while retaining the original snapshotHash', () => {
    const f = fixture(), original = f.run().sources[0], persistedHash = f.observation.snapshotHash;
    const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    const reordered = reorder(f.snapshot);
    expect(createHash('sha256').update(JSON.stringify(reordered)).digest('hex')).not.toBe(persistedHash);
    const output = normalizeCrmControlCallSources({ ...f.observation, snapshot: reordered });
    expect(output.sources[0]).toEqual(original); expect(output.issues).toEqual([]);
  });
  it('binds source identity to its observation, owner and persisted snapshot reference', () => {
    const f = fixture(), original = f.run().sources[0];
    const moved = normalizeCrmControlCallSources({ ...f.observation, id: 'observation-2' }).sources[0];
    expect(moved.sourceHash).toBe(original.sourceHash); expect(moved.sourceIdentityHash).not.toBe(original.sourceIdentityHash);
    const otherSnapshot = normalizeCrmControlCallSources({ ...f.observation, snapshotHash: 'b'.repeat(64) }).sources[0];
    expect(otherSnapshot.sourceIdentityHash).not.toBe(original.sourceIdentityHash);
    const newOwner = normalizeCrmControlCallSources({ ...f.observation, managerId: 'manager-2',
      snapshot: { ...f.snapshot, deal: { ...f.snapshot.deal, responsibleId: 'manager-2' } } }).sources[0];
    expect(newOwner.sourceIdentityHash).not.toBe(original.sourceIdentityHash);
  });
  it('retains exact URL spelling for policy rejection instead of hiding traversal in URL canonicalization', () => {
    const f = fixture(); f.raw.params.link = 'https://userapi.skytel.spb.ru/a/../synthetic.mp3';
    const output = f.run().sources[0];
    expect(output.recordingUrl).toBe(f.raw.params.link);
    expect(output.recordingUrlHash).toBe(createHash('sha256').update(f.raw.params.link).digest('hex'));
  });
  it.each(['2026-08-31T10:00:00Z', '2026-09-23T10:00:00Z'])('rejects call note outside observation window: %s', date => {
    const f = fixture(); f.raw.created_at = time(date); f.raw.updated_at = f.raw.created_at;
    expect(f.run().sources[0]).toMatchObject({ status: 'INVALID', recordingUrl: null, issues: ['CALL_NOTE_TIME_UNVERIFIED'] });
  });
  it('rejects source updated after the snapshot and conflicting external note IDs', () => {
    const f = fixture(); f.raw.updated_at = time('2026-09-23T10:00:00Z');
    expect(f.run().sources[0].status).toBe('INVALID');
    f.raw.updated_at = f.raw.created_at; f.snapshot.notes[0].externalId = '701';
    expect(f.run().sources[0].issues).toContain('CALL_NOTE_IDENTITY_CONFLICT');
  });
  it('uses note identity without inventing a provider call ID and keeps missing recording explicit', () => {
    const f = fixture(); delete (f.raw.params as any).uniq; delete (f.raw.params as any).link;
    expect(f.run().sources[0]).toMatchObject({ status: 'BOUND', providerCallId: null, recordingUrl: null, issues: ['CALL_RECORDING_URL_UNAVAILABLE'] });
  });
  it('reads provider string duration without using it to infer completion, roles or deal binding', () => {
    const f = fixture(); Object.assign(f.raw.params, { duration: '120', source: 'provider', phone: '+0000000', call_status: 4 });
    expect(f.run().sources[0]).toMatchObject({ durationSeconds: 120, speakerRoles: 'UNKNOWN', transcriptQuality: 'NOT_PROCESSED' });
    (f.raw as any).entity_type = 'contacts'; expect(f.run().sources[0].status).toBe('UNBOUND');
  });
  it('does not trust conflicting provider IDs or embedded channel roles', () => {
    const f = fixture(); Object.assign(f.raw.params, { call_id: 'another', channels: [{ role: 'customer', channel: 0 }] });
    expect(f.run().sources[0]).toMatchObject({ status: 'INVALID', speakerRoles: 'UNKNOWN', recordingUrl: null });
  });
  it('deduplicates exact note copies but fences conflicting copies independently of their order', () => {
    const f = fixture(); f.snapshot.notes.push(structuredClone(f.snapshot.notes[0]));
    expect(f.run().sources).toHaveLength(1);
    f.snapshot.notes.push({ ...f.snapshot.notes[0], raw: { ...f.raw, entity_id: 999 } });
    expect(f.run().sources[0]).toMatchObject({ status: 'INVALID', recordingUrl: null, binding: 'UNVERIFIED' });
    f.snapshot.notes.reverse(); expect(f.run().sources[0]).toMatchObject({ status: 'INVALID', recordingUrl: null });
  });
  it('ignores common notes and rejects credentials or control characters in recording URLs', () => {
    const f = fixture(); f.snapshot.notes.push({ raw: { ...f.raw, id: 800, note_type: 'common' } });
    f.raw.params.link = 'https://user:secret@userapi.skytel.spb.ru/audio';
    expect(f.run().sources).toHaveLength(1); expect(f.run().sources[0].recordingUrl).toBeNull();
    f.raw.params.link = 'https://userapi.skytel.spb.ru/audio\n'; expect(f.run().sources[0].recordingUrl).toBeNull();
  });
});
