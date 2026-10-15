import { ReportsService } from './reports.service';

describe('fresh plan-fact calculations', () => {
  const dto = { sourceType: 'EVENT', name: 'CSM: воронка', filters: {}, config: {} } as any;
  const user = { id: 'admin', role: 'ADMIN' } as any;
  const latest = new Date('2026-10-15T08:00:00Z');
  function fixture() {
    const service = new ReportsService({} as any, {} as any) as any;
    service.normalizeBuiltinRequests = jest.fn().mockResolvedValue([dto]);
    service.latestReportSourceSyncAt = jest.fn().mockResolvedValue(latest);
    service.getCachedReport = jest.fn().mockResolvedValue({ sourceSyncAt: new Date('2026-10-15T07:00:00Z'), payload: { type: 'contract', count: 0 } });
    service.assertReportAvailable = jest.fn();
    service.enqueueReportCacheRefresh = jest.fn();
    service.computeFresh = jest.fn().mockResolvedValue({ type: 'contract', count: 1 });
    service.saveCachedReport = jest.fn();
    return service;
  }
  it('does not silently return an outdated zero to plan-fact', async () => {
    const service = fixture();
    expect(await service.compute(dto, user, { requireFresh: true })).toEqual({ type: 'contract', count: 1 });
    expect(service.computeFresh).toHaveBeenCalledWith(dto, user, true);
    expect(service.saveCachedReport).toHaveBeenCalledWith(expect.any(String), dto.name, { type: 'contract', count: 1 }, latest, dto, user);
    expect(service.enqueueReportCacheRefresh).not.toHaveBeenCalled();
  });
  it('keeps the fast path when the saved result is current', async () => {
    const service = fixture();
    service.getCachedReport.mockResolvedValue({ sourceSyncAt: latest, payload: { type: 'contract', count: 1 } });
    expect((await service.compute(dto, user, { requireFresh: true })).count).toBe(1);
    expect(service.computeFresh).not.toHaveBeenCalled();
  });
  it('preserves explicit stale-while-revalidate behavior for other consumers', async () => {
    const service = fixture();
    expect((await service.compute(dto, user)).count).toBe(0);
    expect(service.enqueueReportCacheRefresh).toHaveBeenCalled();
    expect(service.computeFresh).not.toHaveBeenCalled();
  });
  it('does not disguise a failed fresh calculation as an old successful result', async () => {
    const service = fixture();
    service.computeFresh.mockRejectedValue(new Error('calculation failed'));
    await expect(service.compute(dto, user, { requireFresh: true })).rejects.toThrow('calculation failed');
    expect(service.saveCachedReport).not.toHaveBeenCalled();
  });
});
