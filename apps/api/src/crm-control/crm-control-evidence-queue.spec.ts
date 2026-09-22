import { CrmControlService } from './crm-control.service';

function fixture(attempts = 0) {
  const job = { id: 'evidence', observationId: 'observation', sourceUrl: 'https://test.amocrm.ru/leads/detail/123',
    status: 'PENDING', attempts, observation: { dealExternalId: '123', dealTitle: 'Сделка', managerId: 'manager', groupId: 'group' } };
  const prisma = {
    crmControlSettings: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    crmControlEvidence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(job) },
    crmUser: { findUnique: jest.fn().mockResolvedValue({ externalId: '77' }) },
    crmGroup: { findUnique: jest.fn().mockResolvedValue({ externalId: '8' }) },
  };
  const client = { domain: 'test.amocrm.ru', get: jest.fn(async (path: string) => path.startsWith('/leads/')
    ? { id: 123, responsible_user_id: 77 } : { id: 77, rights: { group_id: 8 } }) };
  const amo = { getActiveConnectionOrFail: jest.fn().mockResolvedValue({}), getClient: jest.fn().mockResolvedValue(client) };
  const provider = { capabilities: jest.fn().mockReturnValue({ screenshots: true, health: { status: 'READY', checkedAt: new Date().toISOString() } }),
    runtimeHealth: jest.fn().mockReturnValue({ configurationFingerprint: 'a'.repeat(64), health: { status: 'READY', checkedAt: new Date().toISOString() } }),
    capture: jest.fn().mockResolvedValue({ status: 'READY', storageKey: 'stored.png', sha256: 'hash',
    mimeType: 'image/png', capturedAt: new Date(), message: 'Видимая область карточки' }) };
  const service = new CrmControlService(prisma as any, amo as any, provider as any);
  const completion = () => prisma.crmControlEvidence.updateMany.mock.calls.at(-1)![0];
  return { service, prisma, client, provider, job, completion };
}

describe('CRM control screenshot queue and ownership', () => {
  it('publishes unchanged evidence only after checking the source owner before and after capture', async () => {
    const f = fixture();
    await f.service.processEvidenceQueue();
    expect(f.client.get).toHaveBeenCalledTimes(4);
    expect(f.provider.capture).toHaveBeenCalledTimes(1);
    expect(f.completion()).toMatchObject({ where: { id: 'evidence', status: 'RUNNING', attempts: 1, startedAt: expect.any(Date) },
      data: { status: 'READY', storageKey: 'stored.png', nextAttemptAt: null, error: null, coverage: 'Видимая область карточки' } });
  });

  it('does not capture a delayed or repeated job after the lead was transferred', async () => {
    const f = fixture();
    f.client.get.mockResolvedValueOnce({ id: 123, responsible_user_id: 99 });
    await f.service.processEvidenceQueue();
    expect(f.provider.capture).not.toHaveBeenCalled();
    expect(f.completion().data).toMatchObject({ status: 'ERROR', nextAttemptAt: null });
    expect(f.completion().data.storageKey).toBeUndefined();
  });

  it('does not publish an image when the lead moves while the browser is taking it', async () => {
    const f = fixture();
    f.provider.capture.mockImplementationOnce(async () => {
      f.client.get.mockResolvedValueOnce({ id: 123, responsible_user_id: 99 });
      return { status: 'READY', storageKey: 'must-not-be-published' };
    });
    await f.service.processEvidenceQueue();
    expect(f.completion().data).toMatchObject({ status: 'ERROR', nextAttemptAt: null });
    expect(f.completion().data.storageKey).toBeUndefined();
  });

  it('checks the current CRM group even if the local directory still has the previous group', async () => {
    const f = fixture();
    f.client.get.mockImplementation(async (path: string) => path.startsWith('/leads/')
      ? { id: 123, responsible_user_id: 77 } : { id: 77, rights: { group_id: 999 } });
    await f.service.processEvidenceQueue();
    expect(f.provider.capture).not.toHaveBeenCalled();
    expect(f.completion().data.status).toBe('ERROR');
  });

  it('fails closed when ownership cannot be read and schedules a bounded retry', async () => {
    const f = fixture();
    f.client.get.mockRejectedValueOnce(new Error('Authorization: do-not-expose-token'));
    await f.service.processEvidenceQueue();
    expect(f.provider.capture).not.toHaveBeenCalled();
    expect(f.completion().data).toMatchObject({ status: 'ERROR', nextAttemptAt: expect.any(Date) });
    expect(JSON.stringify(f.completion())).not.toContain('do-not-expose-token');
  });

  it('stops automatic retries after the third failed capture', async () => {
    const f = fixture(2);
    f.provider.capture.mockResolvedValueOnce({ status: 'ERROR', message: 'Сессия недоступна' });
    await f.service.processEvidenceQueue();
    expect(f.completion()).toMatchObject({ where: { attempts: 3 }, data: { status: 'ERROR', nextAttemptAt: null } });
    expect(f.prisma.crmControlEvidence.findFirst.mock.calls[0][0].where.OR[1].attempts).toEqual({ lt: 3 });
  });

  it('does not retry a persistent login or browser configuration failure', async () => {
    const f = fixture();
    f.provider.capture.mockResolvedValueOnce({ status: 'ERROR', errorCode: 'AUTH_REQUIRED', retryable: false, message: 'Войдите заново' } as any);
    await f.service.processEvidenceQueue();
    expect(f.completion().data).toMatchObject({ status: 'ERROR', nextAttemptAt: null, error: 'Войдите заново' });
  });

  it('retries a temporary browser navigation failure', async () => {
    const f = fixture();
    f.provider.capture.mockResolvedValueOnce({ status: 'ERROR', errorCode: 'CARD_NOT_READY', retryable: true, message: 'Карточка не загрузилась' } as any);
    await f.service.processEvidenceQueue();
    expect(f.completion().data).toMatchObject({ status: 'ERROR', nextAttemptAt: expect.any(Date) });
  });

  it('resumes only disabled jobs after a successful live probe', async () => {
    const f = fixture();
    const probe = jest.spyOn(f.service, 'probeEvidence').mockResolvedValue({ status: 'READY', checkedAt: new Date().toISOString() });
    const actor = { id: 'owner' } as any;
    expect(await f.service.requeueDisabledEvidence(actor, 'observation')).toMatchObject({ queued: 1 });
    expect(probe).toHaveBeenCalledWith(actor, 'observation');
    expect(f.prisma.crmControlEvidence.updateMany).toHaveBeenCalledWith({ where: { status: 'DISABLED' },
      data: { status: 'PENDING', attempts: 0, startedAt: null, nextAttemptAt: null, error: null } });
  });

  it('does not resume disabled jobs from configuration alone or a failed login probe', async () => {
    const f = fixture();
    jest.spyOn(f.service, 'probeEvidence').mockResolvedValue({ status: 'ERROR', checkedAt: new Date().toISOString(), message: 'Нет входа' });
    await expect(f.service.requeueDisabledEvidence({ id: 'owner' } as any, 'observation')).rejects.toMatchObject({ status: 400 });
    expect(f.prisma.crmControlEvidence.updateMany).not.toHaveBeenCalled();
  });

  it('requires an owner and an unchanged CRM assignment before probing a card', async () => {
    const f = fixture();
    const row = { ...f.job.observation, id: 'observation', dealUrl: f.job.sourceUrl };
    const visible = jest.spyOn(f.service as any, 'visibleObservation').mockResolvedValue({ row, access: { role: 'ROP' } });
    const probe = jest.fn().mockResolvedValue({ status: 'READY', checkedAt: new Date().toISOString() });
    Object.assign(f.provider, { probe });
    await expect(f.service.probeEvidence({ id: 'rop' } as any, 'observation')).rejects.toMatchObject({ status: 403 });
    expect(probe).not.toHaveBeenCalled();
    visible.mockResolvedValue({ row, access: { role: 'OWNER' } });
    f.client.get.mockResolvedValueOnce({ id: 123, responsible_user_id: 999 });
    await expect(f.service.probeEvidence({ id: 'owner' } as any, 'observation')).rejects.toMatchObject({ status: 400 });
    expect(probe).not.toHaveBeenCalled();
    expect(await f.service.probeEvidence({ id: 'owner' } as any, 'observation')).toMatchObject({ status: 'READY' });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'observation', sourceUrl: f.job.sourceUrl }));
  });

  it('shares only sanitized runtime health without changing the default settings or their version', async () => {
    const f = fixture();
    const checkedAt = new Date().toISOString();
    const configurationFingerprint = 'a'.repeat(64);
    f.provider.runtimeHealth.mockReturnValue({ configurationFingerprint, health: { status: 'ERROR', checkedAt, errorCode: 'AUTH_REQUIRED',
      message: 'cookie=secret', storageState: 'secret', path: 'secret' } } as any);
    await (f.service as any).persistEvidenceHealth();
    const saved = f.prisma.crmControlSettings.upsert.mock.calls[0][0];
    expect(saved.where).toEqual({ id: 'runtime:screenshot-health' });
    expect(saved.update).toEqual({ config: { configurationFingerprint, health: { status: 'ERROR', checkedAt, errorCode: 'AUTH_REQUIRED',
      message: 'amoCRM требует вход. Обновите отдельную сессию сборщика.' } } });
    expect(JSON.stringify(saved)).not.toContain('secret');
    expect(JSON.stringify(saved)).not.toContain('version');
    f.provider.runtimeHealth.mockReturnValue({ configurationFingerprint, health: { status: 'UNVERIFIED', checkedAt: null } } as any);
    f.prisma.crmControlSettings.findUnique.mockResolvedValue({ config: { configurationFingerprint, health: { status: 'READY', checkedAt, unexpected: 'secret' } } } as any);
    expect(await (f.service as any).readEvidenceHealth({ screenshots: true })).toEqual({ status: 'READY', checkedAt });
    expect(await (f.service as any).readEvidenceHealth({ screenshots: false, health: { status: 'ERROR', checkedAt: null, errorCode: 'STATE_EXPIRED' } }))
      .toMatchObject({ status: 'ERROR', errorCode: 'STATE_EXPIRED' });
    f.provider.runtimeHealth.mockReturnValue({ configurationFingerprint: 'b'.repeat(64), health: { status: 'UNVERIFIED', checkedAt: null } } as any);
    expect(await (f.service as any).readEvidenceHealth({ screenshots: true })).toEqual({ status: 'UNVERIFIED', checkedAt: null });
  });

  it('does not start a second browser when another worker claimed the job', async () => {
    const f = fixture();
    f.prisma.crmControlEvidence.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    await f.service.processEvidenceQueue();
    expect(f.provider.capture).not.toHaveBeenCalled();
    expect(f.prisma.crmControlEvidence.updateMany).toHaveBeenCalledTimes(2);
  });
});
