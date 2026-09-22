import { NotFoundException } from '@nestjs/common';
import { CrmControlService } from './crm-control.service';

function fixture() {
  const row = { id: 'observation', dealExternalId: '123', observedAt: new Date('2026-09-21T16:00:00Z'), snapshotHash: 'b'.repeat(64), snapshot: {}, results: [] };
  const evidence = { id: 'evidence', observationId: row.id, status: 'READY', storageKey: `${'a'.repeat(64)}.evidence.json` };
  const prisma = { crmControlEvidence: { findUnique: jest.fn().mockResolvedValue(evidence) } };
  const provider = { read: jest.fn().mockResolvedValue({ buffer: Buffer.from('image') }), readFrame: jest.fn().mockResolvedValue({ buffer: Buffer.from('frame') }),
    readManifest: jest.fn().mockResolvedValue({ version: 1, observedAt: row.observedAt.toISOString(), capturedAt: row.observedAt.toISOString(),
      finishedAt: row.observedAt.toISOString(), truncated: true, limitation: 'Видимые области', coverage: [],
      frames: [{ id: 'card', label: 'Карточка', kind: 'card', storageKey: `${'c'.repeat(64)}.png`, sha256: 'c'.repeat(64), capturedAt: row.observedAt.toISOString(), width: 1600, height: 1200, sourceIds: { tasks: [], notes: [] } }] }) };
  const service = new CrmControlService(prisma as any, {} as any, provider as any);
  const access = jest.spyOn(service as any, 'visibleObservation').mockResolvedValue({ row });
  return { service, provider, access, row, evidence };
}

describe('CRM evidence bundle access', () => {
  it.each(['evidenceFile', 'evidenceManifest', 'evidenceFrameFile'] as const)('checks observation ACL before %s', async method => {
    const f = fixture();
    f.access.mockRejectedValueOnce(new NotFoundException('Проверка недоступна'));
    await expect((f.service[method] as Function)({ id: 'manager' }, 'evidence', 'card')).rejects.toMatchObject({ status: 404 });
    expect(f.provider.read).not.toHaveBeenCalled();
    expect(f.provider.readFrame).not.toHaveBeenCalled();
    expect(f.provider.readManifest).not.toHaveBeenCalled();
  });

  it('supplies immutable binding to every frame read and strips private storage keys from metadata', async () => {
    const f = fixture();
    const actor = { id: 'owner' } as any;
    await f.service.evidenceFile(actor, 'evidence');
    await f.service.evidenceFrameFile(actor, 'evidence', 'card');
    expect(f.provider.readFrame).toHaveBeenCalledWith(f.evidence.storageKey, 'card', expect.objectContaining({ observationId: f.row.id,
      snapshotHash: f.row.snapshotHash, results: f.row.results, snapshot: f.row.snapshot }));
    expect(f.provider.read).toHaveBeenCalledWith(f.evidence.storageKey, expect.objectContaining({ observationId: f.row.id }));
    const output = await f.service.evidenceManifest(actor, 'evidence');
    expect(JSON.stringify(output)).not.toContain('storageKey');
    expect(output.frames[0].downloadUrl).toBe('/crm-control/evidence/evidence/frames/card/file');
  });

  it('returns explicit legacy coverage without fabricating result-to-frame matches', async () => {
    const f = fixture();
    f.provider.readManifest.mockResolvedValue(null as any);
    const output = await f.service.evidenceManifest({ id: 'owner' } as any, 'evidence');
    expect(output).toMatchObject({ version: 0, coverage: [], frames: [{ id: 'legacy', downloadUrl: '/crm-control/evidence/evidence/file' }] });
  });
});
