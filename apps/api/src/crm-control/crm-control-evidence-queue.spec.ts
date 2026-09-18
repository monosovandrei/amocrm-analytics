import { CrmControlService } from './crm-control.service';

function fixture(attempts = 0) {
  const job = { id: 'evidence', observationId: 'observation', sourceUrl: 'https://test.amocrm.ru/leads/detail/123',
    status: 'PENDING', attempts, observation: { dealExternalId: '123', dealTitle: 'Сделка', managerId: 'manager', groupId: 'group' } };
  const prisma = {
    crmControlEvidence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(job) },
    crmUser: { findUnique: jest.fn().mockResolvedValue({ externalId: '77' }) },
    crmGroup: { findUnique: jest.fn().mockResolvedValue({ externalId: '8' }) },
  };
  const client = { domain: 'test.amocrm.ru', get: jest.fn(async (path: string) => path.startsWith('/leads/')
    ? { id: 123, responsible_user_id: 77 } : { id: 77, rights: { group_id: 8 } }) };
  const amo = { getActiveConnectionOrFail: jest.fn().mockResolvedValue({}), getClient: jest.fn().mockResolvedValue(client) };
  const provider = { capture: jest.fn().mockResolvedValue({ status: 'READY', storageKey: 'stored.png', sha256: 'hash',
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

  it('does not start a second browser when another worker claimed the job', async () => {
    const f = fixture();
    f.prisma.crmControlEvidence.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    await f.service.processEvidenceQueue();
    expect(f.provider.capture).not.toHaveBeenCalled();
    expect(f.prisma.crmControlEvidence.updateMany).toHaveBeenCalledTimes(2);
  });
});
