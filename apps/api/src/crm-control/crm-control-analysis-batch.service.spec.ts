import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CrmControlAnalysisBatchService } from './crm-control-analysis-batch.service';
import { CRM_CONTROL_ANALYZER_VERSION } from './crm-control-analysis.service';
import { CRM_CONTROL_LOCAL_PROMPT_VERSION } from './crm-control-local-semantic.client';

const CLOCK = new Date('2026-09-22T20:00:00Z');
const ENV = ['CRM_CONTROL_LOCAL_AI_ORIGIN', 'CRM_CONTROL_LOCAL_AI_MODEL', 'CRM_CONTROL_LOCAL_AI_MODEL_SHA256',
  'CRM_CONTROL_LOCAL_AI_CACHE_DIR', 'CRM_CONTROL_LOCAL_AI_TIMEOUT_MS'] as const;
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((condition: any) => matches(row, condition));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('lte' in value) return row[key] <= value.lte;
    }
    return row[key] === value;
  });
}
function observation(index: number, managerId = 'manager-1', groupId = 'group-1') {
  const id = `observation-${String(index).padStart(3, '0')}`, taskId = `task-${index}`;
  return { id, runId: 'run-1', dealId: `deal-${index}`, managerId, groupId, observedAt: CLOCK,
    stageName: 'КП подготовлено', snapshotHash: 'b'.repeat(64), run: { config: { timeZone: 'Europe/Moscow' } },
    results: [{ id: `result-${index}`, ruleCode: 'task_text', status: 'REVIEW', subjectId: taskId, details: {} }],
    snapshot: { sourceCompleteness: { deal: true, tasks: true, notes: true, communications: false },
      stageEnteredAt: '2026-09-21T10:00:00Z', deal: { raw: { responsible_user_id: managerId } },
      tasks: [{ id: taskId, externalId: taskId, isCompleted: false, title: 'Позвонить клиенту и презентовать КП',
        raw: { responsible_user_id: managerId, created_by: managerId, created_at: 1790078400 } }] } };
}

/** Persisted cursor and conditional writes are modelled; creating a new service loses only process-local state. */
function fixture(observations = [observation(1)]) {
  const state = { batches: [] as any[], observations, latestRun: null as any };
  const db: any = {
    crmControlRun: { findFirst: jest.fn(async () => clone(state.latestRun)) },
    crmControlObservation: { findMany: jest.fn(async ({ where, cursor, skip = 0, take, include }) => {
      const rows = state.observations.filter(row => matches(row, where)).sort((a, b) => a.id.localeCompare(b.id));
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + skip : 0;
      return clone(rows.slice(start, start + take).map(row => ({ ...row,
        results: row.results.filter(result => matches(result, include.results.where)) })));
    }) },
    crmControlAnalysisBatch: {
      findFirst: jest.fn(async ({ where }) => clone(state.batches.find(row => matches(row, where)) ?? null)),
      upsert: jest.fn(async ({ where, create }) => {
        const found = state.batches.find(row => row.requestKey === where.requestKey);
        if (found) return clone(found);
        const row = { id: `batch-${state.batches.length + 1}`, status: 'QUEUED', activeKey: null, leaseToken: null,
          leaseUntil: null, cursor: null, processed: 0, queued: 0, deferred: 0, retryCount: 0, nextAttemptAt: null,
          errorCode: null, createdAt: new Date(), finishedAt: null, ...clone(create) };
        state.batches.push(row); return clone(row);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = state.batches.filter(row => matches(row, where));
        if (data.activeKey && rows.some(row => state.batches.some(other => other.id !== row.id && other.activeKey === data.activeKey))) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        for (const row of rows) for (const [key, value] of Object.entries(data)) {
          row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + (value as any).increment : clone(value);
        }
        return { count: rows.length };
      }),
    },
  };
  const analysis = { enqueue: jest.fn(async (_id: string, _hash: string, _request: any): Promise<any> => ({ id: 'job-1', status: 'QUEUED' })),
    retryTransientError: jest.fn(async (_id: string, _key: string) => true) };
  const service = () => new CrmControlAnalysisBatchService(db, analysis as any);
  return { state, db, analysis, service };
}

describe('durable analysis backfill batches', () => {
  const original = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(CLOCK);
    process.env.CRM_CONTROL_LOCAL_AI_ORIGIN = 'http://127.0.0.1:8091';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL = 'local-test';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = 'a'.repeat(64);
    process.env.CRM_CONTROL_LOCAL_AI_CACHE_DIR = path.resolve('tmp/analysis-batch-test');
    delete process.env.CRM_CONTROL_LOCAL_AI_TIMEOUT_MS;
  });
  afterEach(() => {
    for (const key of ENV) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    jest.useRealTimers();
  });

  it('resumes 45 observations over three persisted pages after worker restarts, without skipping or repeating results', async () => {
    const f = fixture(Array.from({ length: 45 }, (_, i) => observation(i)));
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:run-1:actor:request');
    await f.service().processQueue();
    expect(f.state.batches[0]).toMatchObject({ status: 'QUEUED', cursor: 'observation-019', processed: 20, queued: 20 });
    await f.service().processQueue();
    expect(f.state.batches[0]).toMatchObject({ status: 'QUEUED', cursor: 'observation-039', processed: 40 });
    await f.service().processQueue();
    expect(f.state.batches[0]).toMatchObject({ status: 'COMPLETED', cursor: 'observation-044', processed: 45, queued: 45, deferred: 0 });
    expect(new Set(f.analysis.enqueue.mock.calls.map(call => call[0])).size).toBe(45);
    expect(f.db.crmControlObservation.findMany.mock.calls.map(([query]: any) => [query.take, query.cursor?.id, query.skip]))
      .toEqual([[20, undefined, undefined], [20, 'observation-019', 1], [20, 'observation-039', 1]]);
  });

  it.each([
    [{ role: 'OWNER' }, ['result-1', 'result-2', 'result-3']],
    [{ role: 'ROP', groupId: 'group-1' }, ['result-1', 'result-2']],
    [{ role: 'MANAGER', managerId: 'manager-1' }, ['result-1']],
  ])('limits frozen sources to the persisted %j scope', async (scope, expected) => {
    const f = fixture([observation(1), observation(2, 'manager-2'), observation(3, 'manager-3', 'group-2')]);
    await f.service().enqueue('run-1', scope as any, 'manual:scope'); await f.service().processQueue();
    expect(f.analysis.enqueue.mock.calls.map(call => call[0])).toEqual(expected);
  });

  it.each([{ role: 'MANAGER' }, { role: 'ROP' }, { role: 'ADMIN' }])('rejects an unbound or unsupported scope %j before reading observations', async scope => {
    const f = fixture();
    await expect(f.service().enqueue('run-1', scope as any, 'manual:invalid')).rejects.toBeInstanceOf(BadRequestException);
    expect(f.state.batches).toHaveLength(0); expect(f.db.crmControlObservation.findMany).not.toHaveBeenCalled();
  });

  it('continues past a rejected frozen record and an unbuildable request, while retaining deferred counts', async () => {
    const rows = [observation(1), observation(2), observation(3)]; rows[1].snapshot.sourceCompleteness.deal = false;
    const f = fixture(rows); f.analysis.enqueue.mockRejectedValueOnce(new BadRequestException('Snapshot mismatch'));
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:poison'); await f.service().processQueue();
    expect(f.analysis.enqueue.mock.calls.map(call => call[0])).toEqual(['result-1', 'result-3']);
    expect(f.state.batches[0]).toMatchObject({ status: 'COMPLETED', processed: 3, queued: 1, deferred: 2, retryCount: 0 });
  });

  it('stops a stale worker before enqueue and does not advance its cursor after the lease expires during the source read', async () => {
    const f = fixture(); const read = f.db.crmControlObservation.findMany.getMockImplementation();
    f.db.crmControlObservation.findMany.mockImplementation(async (query: any) => {
      const rows = await read(query); jest.setSystemTime(CLOCK.getTime() + 120_001); return rows;
    });
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:expired'); await f.service().processQueue();
    expect(f.analysis.enqueue).not.toHaveBeenCalled();
    expect(f.state.batches[0]).toMatchObject({ status: 'RUNNING', cursor: null, processed: 0 });
    f.db.crmControlObservation.findMany.mockImplementation(read);
    await f.service().processQueue();
    expect(f.analysis.enqueue).toHaveBeenCalledTimes(1);
    expect(f.state.batches[0]).toMatchObject({ status: 'COMPLETED', processed: 1 });
  });

  it('does not finalize over a replacement worker after an enqueue returns late', async () => {
    const f = fixture();
    f.analysis.enqueue.mockImplementationOnce(async () => {
      Object.assign(f.state.batches[0], { leaseToken: 'replacement-worker', cursor: 'replacement-cursor', processed: 9 });
      return { id: 'job-1', status: 'QUEUED' };
    });
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:replaced'); await f.service().processQueue();
    expect(f.state.batches[0]).toMatchObject({ status: 'RUNNING', leaseToken: 'replacement-worker', cursor: 'replacement-cursor', processed: 9 });
  });

  it('retries a transient page at 30/60 seconds, stops after the third failure, and preserves the cursor', async () => {
    const f = fixture(); f.analysis.enqueue.mockRejectedValue(new Error('temporary database outage'));
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:transient');
    await f.service().processQueue(); await f.service().processQueue();
    expect(f.analysis.enqueue).toHaveBeenCalledTimes(1);
    expect(f.state.batches[0]).toMatchObject({ status: 'QUEUED', retryCount: 1, cursor: null, nextAttemptAt: new Date(CLOCK.getTime() + 30_000) });
    jest.setSystemTime(CLOCK.getTime() + 30_000); await f.service().processQueue();
    expect(f.state.batches[0].nextAttemptAt).toEqual(new Date(CLOCK.getTime() + 90_000));
    jest.setSystemTime(CLOCK.getTime() + 90_000); await f.service().processQueue(); await f.service().processQueue();
    expect(f.analysis.enqueue).toHaveBeenCalledTimes(3);
    expect(f.state.batches[0]).toMatchObject({ status: 'ERROR', retryCount: 3, processed: 0, cursor: null, nextAttemptAt: null });
  });

  it('does not grant a manual retry after the lease expired while enqueue was pending', async () => {
    const f = fixture();
    f.analysis.enqueue.mockImplementationOnce(async () => {
      jest.setSystemTime(CLOCK.getTime() + 120_001); return { id: 'terminal-job', status: 'ERROR' };
    });
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:late-retry'); await f.service().processQueue();
    expect(f.analysis.retryTransientError).not.toHaveBeenCalled();
    expect(f.state.batches[0]).toMatchObject({ status: 'RUNNING', processed: 0, cursor: null });
  });

  it('uses the persisted manual request key when granting retries, including a replayed page', async () => {
    const f = fixture([observation(1), observation(2)]);
    f.analysis.enqueue.mockResolvedValue({ id: 'error-job', status: 'ERROR' }).mockResolvedValueOnce({ id: 'error-job', status: 'ERROR' })
      .mockRejectedValueOnce(new Error('temporary'));
    await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:run-1:actor:stable-request');
    await f.service().processQueue(); jest.setSystemTime(CLOCK.getTime() + 30_000); await f.service().processQueue();
    expect(f.analysis.retryTransientError.mock.calls).toEqual(Array(3).fill(['error-job', 'manual:run-1:actor:stable-request']));
    expect(f.state.batches[0]).toMatchObject({ status: 'COMPLETED', processed: 2 });
  });

  it('automatically enqueues only the latest run scope, with an identity key, and never grants automatic retry extensions', async () => {
    const f = fixture([observation(1), observation(2, 'manager-2', 'group-2')]);
    f.state.latestRun = { id: 'run-1', config: { _access: { role: 'ROP', groupId: 'group-1' } } };
    f.analysis.enqueue.mockResolvedValue({ id: 'terminal-job', status: 'ERROR' });
    await f.service().processQueue(); await f.service().processQueue();
    const version = createHash('sha256').update(JSON.stringify(['local-test', 'a'.repeat(64), CRM_CONTROL_ANALYZER_VERSION, CRM_CONTROL_LOCAL_PROMPT_VERSION])).digest('hex');
    expect(f.state.batches).toHaveLength(1);
    expect(f.state.batches[0]).toMatchObject({ requestKey: `automatic:run-1:${version}`, scopeRole: 'ROP', groupId: 'group-1' });
    expect(f.analysis.enqueue.mock.calls.map(call => call[0])).toEqual(['result-1']);
    expect(f.analysis.retryTransientError).not.toHaveBeenCalled();
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = 'c'.repeat(64); await f.service().processQueue();
    expect(f.state.batches).toHaveLength(2);
    expect(f.state.batches[1].requestKey).not.toBe(f.state.batches[0].requestKey);
  });

  it('does not create a second active batch in the same scope or run without an approved local configuration', async () => {
    const f = fixture();
    const first = await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:first');
    expect((await f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:second')).id).toBe(first.id);
    delete process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256;
    await expect(f.service().enqueue('run-1', { role: 'OWNER' }, 'manual:disabled')).rejects.toBeInstanceOf(BadRequestException);
    await f.service().processQueue(); expect(f.analysis.enqueue).not.toHaveBeenCalled();
  });
});
