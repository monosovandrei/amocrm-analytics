import { DataQualityService } from './data-quality.service';

describe('DataQualityService', () => {
  it('does not block on the first transient mismatch', async () => {
    const prisma = {
      dataQualityIncident: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
      },
    };
    const service = new DataQualityService(prisma as any) as any;
    const detectedAt = new Date('2026-09-01T09:00:00.000Z');

    await service.synchronizeIncidents('connection-1', [{
      code: 'FACT_DEAL_COVERAGE_MISMATCH',
      message: 'mismatch',
      severity: 'CRITICAL',
      scope: { global: true },
    }], detectedAt);

    expect(prisma.dataQualityIncident.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ confirmedAt: null }),
    }));
  });

  it('confirms a persistent mismatch only after three detections and ten minutes', async () => {
    const firstDetectedAt = new Date('2026-09-01T09:00:00.000Z');
    const now = new Date('2026-09-01T09:11:00.000Z');
    const prisma = {
      dataQualityIncident: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'incident-1',
          connectionId: 'connection-1',
          code: 'FACT_DEAL_COVERAGE_MISMATCH',
          detectionCount: 2,
          firstDetectedAt,
          confirmedAt: null,
          status: 'OPEN',
        }]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new DataQualityService(prisma as any) as any;

    await service.synchronizeIncidents('connection-1', [{
      code: 'FACT_DEAL_COVERAGE_MISMATCH',
      message: 'mismatch',
      severity: 'CRITICAL',
      scope: { global: true },
    }], now);

    expect(prisma.dataQualityIncident.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'incident-1' },
      data: expect.objectContaining({ detectionCount: 3, confirmedAt: now }),
    }));
  });

  it('blocks only reports covered by a scoped incident', async () => {
    const service = new DataQualityService({} as any);
    const current = {
      overall: 'BLOCKED',
      checkedAt: '2026-09-01T09:00:00.000Z',
      cutoffAt: '2026-09-01T08:59:00.000Z',
      incidents: [{
        id: 'incident-csm',
        code: 'CSM_MISMATCH',
        message: 'CSM mismatch',
        confirmedAt: new Date('2026-09-01T09:00:00.000Z'),
        scope: { pipelineIds: ['csm-pipeline'] },
      }],
    } as any;

    const csm = await service.reportQuality(
      { name: 'CSM', filters: { pipelineIds: ['csm-pipeline'] } },
      new Date(),
      current,
    );
    const sales = await service.reportQuality(
      { name: 'Sales', filters: { pipelineIds: ['sales-pipeline'] } },
      new Date(),
      current,
    );

    expect(csm).toEqual(expect.objectContaining({ status: 'BLOCKED', incidentId: 'incident-csm' }));
    expect(sales).toEqual(expect.objectContaining({ status: 'CHECKING', incidentId: null }));
  });

  it('does not certify a snapshot older than the verified amoCRM cutoff', async () => {
    const service = new DataQualityService({} as any);
    const current = {
      overall: 'CERTIFIED',
      checkedAt: '2026-09-01T09:05:00.000Z',
      cutoffAt: '2026-09-01T09:05:00.000Z',
      incidents: [],
    } as any;

    const stale = await service.reportQuality(
      { name: 'Sales', filters: {} },
      new Date('2026-09-01T09:00:00.000Z'),
      current,
    );
    const currentSnapshot = await service.reportQuality(
      { name: 'Sales', filters: {} },
      new Date('2026-09-01T09:04:00.000Z'),
      current,
    );

    expect(stale.status).toBe('CHECKING');
    expect(currentSnapshot.status).toBe('CERTIFIED');
  });
});
