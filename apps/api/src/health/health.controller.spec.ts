import { HealthController } from './health.controller';
import { REQUIRED_WORKER_ROLES } from '../quality/release-info';

describe('HealthController required workers', () => {
  const old = new Date(Date.now() - 20 * 60_000);
  const current = () => new Date();
  const worker = (role: string, heartbeatAt = current()) => ({ role, startedAt: old, heartbeatAt });
  async function health(workers: any[]) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      amoConnection: { findFirst: jest.fn().mockResolvedValue(null) },
      reportSnapshotJob: { groupBy: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
      reportSnapshot: { count: jest.fn().mockResolvedValue(0) },
      workerRuntime: { findMany: jest.fn().mockResolvedValue(workers) },
    };
    return new HealthController(prisma as any, {} as any).health();
  }
  it('does not require a retired CRM-control process or count its stale heartbeat', async () => {
    const result = await health([...REQUIRED_WORKER_ROLES.map(r => worker(r)), worker('crm-control', old)]);
    expect(result.redConditions.workerMissing).toBe(false);
    expect(result.redConditions.workerHeartbeatStale).toBe(false);
    expect(result.status).toBe('ok');
  });
  it('detects every missing required process', async () => {
    for (const missing of REQUIRED_WORKER_ROLES) {
      const result = await health(REQUIRED_WORKER_ROLES.filter(r => r !== missing).map(r => worker(r)));
      expect(result.redConditions.workerMissing).toBe(true);
      expect(result.status).toBe('degraded');
    }
  });
  it('still detects a stalled required process', async () => {
    const result = await health(REQUIRED_WORKER_ROLES.map(r => worker(r, r === 'report' ? old : current())));
    expect(result.redConditions.workerHeartbeatStale).toBe(true);
    expect(result.status).toBe('degraded');
  });
});
