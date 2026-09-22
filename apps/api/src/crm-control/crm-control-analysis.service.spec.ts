import path from 'node:path';
import { CRM_CONTROL_ANALYZER_VERSION, CrmControlAnalysisService, crmControlLocalAnalysisOptions } from './crm-control-analysis.service';
import { CRM_CONTROL_LOCAL_PROMPT_VERSION, CrmControlLocalSemanticClient } from './crm-control-local-semantic.client';
import { CrmControlSemanticRequest, crmControlSemanticTextHash } from './crm-control-semantic.validation';
import { buildCrmControlSemanticRequest } from './crm-control-semantic.request';

const CLOCK = new Date('2026-09-22T20:00:00Z');
const SNAPSHOT_HASH = 'b'.repeat(64);
const MODEL_HASH = 'a'.repeat(64);
const ENV = ['CRM_CONTROL_LOCAL_AI_ORIGIN', 'CRM_CONTROL_LOCAL_AI_MODEL', 'CRM_CONTROL_LOCAL_AI_MODEL_SHA256',
  'CRM_CONTROL_LOCAL_AI_CACHE_DIR', 'CRM_CONTROL_LOCAL_AI_TIMEOUT_MS'] as const;
const clone = <T>(value: T): T => structuredClone(value);

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((condition: any) => matches(row, condition));
    const isDate = Object.prototype.toString.call(value) === '[object Date]';
    if (value && typeof value === 'object' && !isDate) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('lt' in value) return row[key] < (value.lt?.kind === 'field' ? row[value.lt.name] : value.lt);
      if ('lte' in value) return row[key] <= value.lte;
      if ('gt' in value) return row[key] > value.gt;
    }
    return isDate ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
}

/** Transactional in-memory test store: CAS, uniqueness and rollback are exercised, not stubbed as always successful. */
function fixture() {
  const text = 'Позвонить клиенту и согласовать презентацию КП.';
  const request: CrmControlSemanticRequest = { schemaVersion: 1, requestId: 'initial-request', check: 'task_action',
    dealId: 'amo:100', ownerId: 'manager-1', subjectId: 'task-1', stageName: 'КП подготовлено', timeZone: 'Europe/Moscow',
    observedAt: CLOCK.toISOString(), stageEnteredAt: '2026-09-21T10:00:00Z',
    coverage: { tasks: true, notes: true, communications: false }, sources: [{ id: 'task-1', dealId: 'amo:100', ownerId: 'manager-1',
      subjectId: 'task-1', assignedManagerId: 'manager-1', kind: 'task', actor: 'bot', actorId: 'robot-1', direction: 'internal',
      text, sourceHash: crmControlSemanticTextHash(text), createdAt: '2026-09-22T10:00:00Z' }] };
  const result = { id: 'result-1', ruleCode: 'task_text', subjectId: 'task-1', status: 'REVIEW', details: {},
    observation: { id: 'observation-1', dealId: 'amo:100', managerId: 'manager-1', stageName: request.stageName,
      run: { config: { timeZone: request.timeZone } },
      snapshotHash: SNAPSHOT_HASH, observedAt: CLOCK, snapshot: { stageEnteredAt: request.stageEnteredAt,
        sourceCompleteness: { ...request.coverage, deal: true }, deal: { raw: { responsible_user_id: 'crm-manager-1' } },
        tasks: [{ externalId: 'task-1', id: 'amo:task-1', isCompleted: false, title: text,
          raw: { text, created_at: Date.parse('2026-09-22T10:00:00Z') / 1000, created_by: 'robot-1', responsible_user_id: 'crm-manager-1' } }] } } };
  Object.assign(request, buildCrmControlSemanticRequest(result.observation, result), { requestId: 'initial-request' });
  const state = { jobs: [] as any[], attempts: [] as any[], grants: [] as any[], results: [clone(result)] };
  const db: any = {
    crmControlResult: { findUnique: jest.fn(async ({ where }) => clone(state.results.find(row => row.id === where.id) ?? null)) },
    crmControlAnalysisJob: {
      fields: { attemptLimit: { kind: 'field', name: 'attemptLimit' } },
      findFirst: jest.fn(async ({ where }) => clone(state.jobs.find(row => matches(row, where)) ?? null)),
      findMany: jest.fn(async ({ where, take }) => clone(state.jobs.filter(row => matches(row, where)).slice(0, take))),
      findUnique: jest.fn(async ({ where }) => clone(state.jobs.find(row => row.id === where.id) ?? null)),
      upsert: jest.fn(async ({ where, create }) => {
        const found = state.jobs.find(row => matches(row, where.resultId_inputHash_analyzerVersion));
        if (found) return clone(found);
        const row = { id: `job-${state.jobs.length + 1}`, status: 'QUEUED', activeKey: null, leaseToken: null, leaseUntil: null,
          startedAt: null, finishedAt: null, nextAttemptAt: null, attemptCount: 0, attemptLimit: 3,
          errorCode: null, createdAt: new Date(), ...clone(create) };
        state.jobs.push(row); return clone(row);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = state.jobs.filter(item => matches(item, where));
        for (const row of rows) {
          if (data.activeKey && state.jobs.some(item => item.id !== row.id && item.activeKey === data.activeKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
          for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
            ? row[key] + (value as any).increment : clone(value);
        }
        return { count: rows.length };
      }),
    },
    crmControlAnalysisAttempt: { create: jest.fn(async ({ data }) => {
      if (state.attempts.some(row => row.jobId === data.jobId && row.attemptNo === data.attemptNo)) throw new Error('duplicate attempt');
      const row = { id: `attempt-${state.attempts.length + 1}`, ...clone(data) };
      state.attempts.push(row); return clone(row);
    }) },
    crmControlAnalysisRetryGrant: {
      findUnique: jest.fn(async ({ where }) => clone(state.grants.find(row => matches(row, where.jobId_requestKey)) ?? null)),
      create: jest.fn(async ({ data }) => {
        if (state.grants.some(row => row.jobId === data.jobId && row.requestKey === data.requestKey)) throw Object.assign(new Error('duplicate grant'), { code: 'P2002' });
        const row = { id: `grant-${state.grants.length + 1}`, ...clone(data) };
        state.grants.push(row); return clone(row);
      }),
    },
  };
  let queue = Promise.resolve();
  db.$transaction = async (operation: (tx: any) => Promise<unknown>) => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const before = clone({ jobs: state.jobs, attempts: state.attempts, grants: state.grants });
    try { return await operation(db); }
    catch (error) { state.jobs = before.jobs; state.attempts = before.attempts; state.grants = before.grants; throw error; }
    finally { release(); }
  };
  const service = new CrmControlAnalysisService(db);
  const enqueue = () => service.enqueue('result-1', SNAPSHOT_HASH, request);
  const ready = (input: CrmControlSemanticRequest) => ({ status: 'READY' as const, inputHash: state.jobs.find(job => job.request.requestId === input.requestId)!.inputHash,
    cacheHit: false, completedAt: new Date().toISOString(), model: 'local-test', modelSha256: MODEL_HASH,
    promptVersion: CRM_CONTROL_LOCAL_PROMPT_VERSION, response: { schemaVersion: 1 as const, requestId: input.requestId, check: input.check,
      subjectId: input.subjectId, inspectedSourceIds: input.sources.map(source => source.id), findings: ['action', 'stage_relevance'].map(fact => ({
        fact: fact as 'action' | 'stage_relevance', state: 'present' as const,
        evidence: [{ sourceId: input.sources[0].id, sourceHash: input.sources[0].sourceHash, quote: input.sources[0].text }],
      })) }, validation: { status: 'VALIDATED' as const, requestId: input.requestId, check: input.check, subjectId: input.subjectId, findings: [], issues: [] } });
  return { db, state, request, service, enqueue, ready };
}

describe('persistent local semantic analysis queue', () => {
  const original = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(CLOCK);
    process.env.CRM_CONTROL_LOCAL_AI_ORIGIN = 'http://127.0.0.1:8091';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL = 'local-test';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = MODEL_HASH;
    process.env.CRM_CONTROL_LOCAL_AI_CACHE_DIR = path.resolve('tmp/local-semantic-test');
    delete process.env.CRM_CONTROL_LOCAL_AI_TIMEOUT_MS;
  });
  afterEach(() => {
    for (const key of ENV) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    jest.restoreAllMocks(); jest.useRealTimers();
  });

  it.each(['', 'https://external.example:8091', 'http://localhost:8091', 'http://127.0.0.1:8091/remote'])('never enqueues or processes with an absent/nonliteral local origin: %s', origin => {
    process.env.CRM_CONTROL_LOCAL_AI_ORIGIN = origin;
    expect(crmControlLocalAnalysisOptions()).toBeNull();
  });

  it('leaves the queue untouched when the local runtime is not configured', async () => {
    delete process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256;
    const f = fixture();
    expect(await f.enqueue()).toEqual({ status: 'DISABLED', code: 'LOCAL_AI_NOT_CONFIGURED' });
    await f.service.processQueue();
    expect(f.db.crmControlResult.findUnique).not.toHaveBeenCalled();
    expect(f.db.crmControlAnalysisJob.findFirst).not.toHaveBeenCalled();
  });
  it('hydrates only the server-selected immutable private archive and rejects caller-supplied mail', async () => {
    const f = fixture(), result = f.state.results[0], observation = result.observation as any;
    const start = '2026-09-22T18:00:00.000Z', finish = '2026-09-22T18:01:00.000Z';
    Object.assign(result, { ruleCode: 'stage_duration', subjectId: '', details: { maximumDueAt: '2026-09-22T12:00:00Z' } });
    observation.dealExternalId = '100';
    observation.snapshot.notes = [];
    Object.assign(observation.snapshot.deal, { id: 'amo:100', responsibleId: 'manager-1' });
    Object.assign(observation.snapshot.deal.raw, { id: 100, account_id: 42, _embedded: { contacts: [{ id: 55 }] } });
    observation.snapshot.browserSources = { connectionId: 'connection-1', accountExternalId: '42', startedAt: start, finishedAt: finish,
      manifest: { storageKey: 'a'.repeat(64) + '.browser-history.json', sha256: 'a'.repeat(64), size: 1000 } };
    const manifest = { connectionId: 'connection-1', accountExternalId: '42', dealExternalId: '100', startedAt: start, finishedAt: finish,
      history: { dealExternalId: '100', entries: [], threads: [{ id: '11', binding: 'DEAL', messages: [{ id: '22', sent: false,
        occurredAt: start, content: 'Да, перенесём на 25.09.2026.', participants: { from: [{ type: 'contact', id: '55' }], reasonCodes: [] } }] }] } };
    const reader = { readManifest: jest.fn().mockResolvedValue(manifest) };
    f.db.amoConnection = { findUnique: jest.fn().mockResolvedValue({ id: 'connection-1', accountId: '42' }) };
    const service = new CrmControlAnalysisService(f.db, reader as any);
    const request = buildCrmControlSemanticRequest(observation, result)!;
    await service.enqueue(result.id, SNAPSHOT_HASH, request);
    expect(reader.readManifest).toHaveBeenCalledWith(observation.snapshot.browserSources.manifest, '100');
    expect(f.state.jobs[0].request.sources).toEqual([expect.objectContaining({ id: 'mail:11:22', actor: 'customer' })]);
    expect(f.state.jobs[0].request.coverage.communications).toBe(false);
    await expect(service.enqueue(result.id, SNAPSHOT_HASH, { ...request, sources: f.state.jobs[0].request.sources })).rejects.toThrow('сохранённым данным');
  });

  it.each(['dealId', 'ownerId', 'subjectId', 'observedAt', 'stageName', 'stageEnteredAt', 'check', 'timeZone', 'taskDueAt', 'maxDueAt'] as const)('rejects mismatched archived %s', key => {
    const f = fixture();
    (f.request as any)[key] = key === 'check' ? 'proposal_note' : 'other';
    return expect(f.enqueue()).rejects.toThrow('сохранённым данным');
  });

  it('rejects a wrong snapshot hash and inflated source coverage', async () => {
    const f = fixture();
    await expect(f.service.enqueue('result-1', 'c'.repeat(64), f.request)).rejects.toThrow('сохранённым данным');
    f.request.coverage.communications = true;
    await expect(f.enqueue()).rejects.toThrow('сохранённым данным');
    expect(f.state.jobs).toHaveLength(0);
  });

  it('rejects a caller-authored source even when its replacement text has a matching SHA-256', async () => {
    const f = fixture();
    f.request.sources[0].text = 'Клиент согласился на любые условия.';
    f.request.sources[0].sourceHash = crmControlSemanticTextHash(f.request.sources[0].text);
    await expect(f.enqueue()).rejects.toThrow('Источники анализа не соответствуют');
    expect(f.state.jobs).toHaveLength(0);
  });

  it.each(['createdAt', 'actorId', 'assignedManagerId', 'id'] as const)('rejects source metadata forged after snapshot construction: %s', key => {
    const f = fixture();
    f.request.sources[0][key] = 'forged';
    return expect(f.enqueue()).rejects.toThrow('Источники анализа не соответствуют');
  });

  it('is idempotent despite another caller request ID or object key order, without changing the original result', async () => {
    const f = fixture();
    const archived = clone(f.state.results);
    const first = await f.enqueue();
    const reordered = Object.fromEntries(Object.entries(f.request).reverse()) as unknown as CrmControlSemanticRequest;
    reordered.requestId = 'different-request';
    const second = await f.service.enqueue('result-1', SNAPSHOT_HASH, reordered);
    expect(second).toEqual(first);
    expect(f.state.jobs).toHaveLength(1);
    expect(f.state.jobs[0].request.requestId).not.toBe('initial-request');
    expect(f.state.results).toEqual(archived);
  });

  it('stores a validated response as a private append-only attempt, not a rule PASS', async () => {
    const f = fixture(); await f.enqueue();
    const archived = clone(f.state.results);
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => f.ready(input));
    await f.service.processQueue();
    expect(analyze).toHaveBeenCalledWith(f.state.jobs[0].request);
    expect(f.state.jobs[0]).toMatchObject({ status: 'READY', activeKey: null, leaseToken: null, attemptCount: 1,
      assessmentStatus: 'PASS', assessmentMessage: expect.any(String), policyVersion: expect.any(String) });
    expect(f.state.attempts).toHaveLength(1);
    expect(f.state.attempts[0]).toMatchObject({ status: 'READY', validation: { status: 'VALIDATED' }, rawResponse: { response: { check: 'task_action' } } });
    expect(f.state.results).toEqual(archived);
    const attempts = clone(f.state.attempts);
    await f.service.processQueue();
    expect(f.state.attempts).toEqual(attempts);
  });

  it('revalidates the response and preserves UNKNOWN despite a client VALIDATED claim', async () => {
    const f = fixture(); f.request.coverage.tasks = false;
    f.state.results[0].observation.snapshot.sourceCompleteness.tasks = false; await f.enqueue();
    jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => f.ready(input));
    await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'UNKNOWN', assessmentStatus: 'UNKNOWN' });
    expect(f.state.attempts[0].validation.issues).toContainEqual({ code: 'INCOMPLETE_TASKS' });
  });

  it.each([true, false])('preserves raw REVIEW and evaluates complete empty notes without a model (complete=%s)', async complete => {
    const f = fixture(), result = f.state.results[0];
    Object.assign(result, { ruleCode: 'proposal_note', subjectId: '' });
    Object.assign(result.observation.snapshot, { notes: [], tasks: [] });
    result.observation.snapshot.sourceCompleteness.notes = complete;
    Object.assign(f.request, buildCrmControlSemanticRequest(result.observation, result));
    const send = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected model call'));
    await f.enqueue(); await f.service.processQueue();
    expect(send).not.toHaveBeenCalled();
    expect(f.state.jobs[0]).toMatchObject({ status: complete ? 'READY' : 'UNKNOWN', errorCode: null, assessmentStatus: complete ? 'FAIL' : 'UNKNOWN',
      assessmentMessage: expect.stringContaining(complete ? 'нет причины переноса' : 'нет текстовых источников') });
    expect(f.state.attempts[0]).toMatchObject({ status: complete ? 'READY' : 'UNKNOWN', rawResponse: { status: 'READY',
      inputHash: f.state.jobs[0].inputHash, validation: { status: complete ? 'VALIDATED' : 'UNKNOWN' } } });
    expect(result.status).toBe('REVIEW');
  });
  it.each([true, false])('projects decisive missing manager note only with complete notes (%s)', async complete => {
    const f = fixture(), result = f.state.results[0];
    Object.assign(result, { ruleCode: 'stage_duration', subjectId: '', details: { maximumDueAt: '2026-09-22T15:00:00Z' } });
    Object.assign(result.observation.snapshot, { notes: [], tasks: [] });
    result.observation.snapshot.sourceCompleteness.notes = complete;
    Object.assign(f.request, buildCrmControlSemanticRequest(result.observation, result));
    const send = jest.spyOn(globalThis, 'fetch').mockRejectedValue(Error('unexpected model call'));
    await f.enqueue(); await f.service.processQueue();
    expect(send).not.toHaveBeenCalled();
    expect(f.state.jobs[0]).toMatchObject({ status: complete ? 'READY' : 'UNKNOWN', assessmentStatus: complete ? 'FAIL' : 'UNKNOWN', errorCode: null });
    expect(f.state.attempts[0]).toMatchObject({ status: complete ? 'READY' : 'UNKNOWN', validation: { status: 'UNKNOWN' } });
    expect(result.status).toBe('REVIEW');
  });
  it.each([
    ['2026-09-20T10:00:00Z', 'FAIL'], [null, 'UNKNOWN'], ['2026-09-23T10:00:00Z', 'UNKNOWN'],
  ])('resolves the current stage empty window without masking an uncertain note date: %s', async (createdAt, expected) => {
    const f = fixture(), result = f.state.results[0];
    Object.assign(result, { ruleCode: 'proposal_note', subjectId: '' });
    Object.assign(result.observation.snapshot, { notes: [{ id: 'note-1', type: 'common', text: 'Презентация позже', createdAt,
      raw: { created_by: 'crm-manager-1' } }] });
    Object.assign(f.request, buildCrmControlSemanticRequest(result.observation, result));
    const send = jest.spyOn(globalThis, 'fetch').mockRejectedValue(Error('unexpected model call'));
    await f.enqueue(); await f.service.processQueue();
    expect(send).not.toHaveBeenCalled(); expect(f.state.jobs[0].assessmentStatus).toBe(expected);
    expect(result.status).toBe('REVIEW');
  });

  it('does not accept a response for another model or input', async () => {
    const f = fixture(); await f.enqueue();
    jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => ({ ...f.ready(input), inputHash: 'c'.repeat(64) }));
    await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', errorCode: 'LOCAL_AI_IDENTITY_MISMATCH', nextAttemptAt: null, assessmentStatus: 'UNKNOWN' });
  });

  it('stores a policy FAIL separately from the original REVIEW and validated facts', async () => {
    const f = fixture(); await f.enqueue();
    jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => {
      const response = f.ready(input);
      (response.response.findings[0] as any).state = 'absent';
      response.response.findings[0].evidence = [];
      return response;
    });
    await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'READY', assessmentStatus: 'FAIL', policyVersion: expect.any(String) });
    expect(f.state.results[0].status).toBe('REVIEW');
    expect(f.state.attempts[0].validation.status).toBe('VALIDATED');
  });

  it('retries only transient failures after 30/60 seconds and stops after three attempts', async () => {
    const f = fixture(); await f.enqueue();
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockResolvedValue({ status: 'ERROR', code: 'LOCAL_AI_TIMEOUT', retryable: true });
    await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'QUEUED', attemptCount: 1, nextAttemptAt: new Date(CLOCK.getTime() + 30_000) });
    await f.service.processQueue(); expect(analyze).toHaveBeenCalledTimes(1);
    jest.setSystemTime(CLOCK.getTime() + 30_000); await f.service.processQueue();
    expect(f.state.jobs[0].nextAttemptAt).toEqual(new Date(CLOCK.getTime() + 90_000));
    jest.setSystemTime(CLOCK.getTime() + 90_000); await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', attemptCount: 3, nextAttemptAt: null });
    await f.service.processQueue(); expect(analyze).toHaveBeenCalledTimes(3);
    expect(f.state.attempts.map(row => [row.attemptNo, row.retryable])).toEqual([[1, true], [2, true], [3, false]]);
  });

  it('does not retry malformed semantic responses even if the client requests a retry', async () => {
    const f = fixture(); await f.enqueue();
    jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockResolvedValue({ status: 'ERROR', code: 'LOCAL_AI_INVALID_RESPONSE', retryable: true });
    await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', nextAttemptAt: null, attemptCount: 1 });
  });

  it('grants exactly three more attempts after a manual retry and preserves attempts 1–3', async () => {
    const f = fixture(); await f.enqueue();
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockResolvedValue({ status: 'ERROR', code: 'LOCAL_AI_TIMEOUT', retryable: true });
    for (const ms of [0, 30_000, 90_000]) { jest.setSystemTime(CLOCK.getTime() + ms); await f.service.processQueue(); }
    const firstAttempts = clone(f.state.attempts);
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', attemptCount: 3, attemptLimit: 3 });
    await f.enqueue(); await f.service.processQueue();
    expect(analyze).toHaveBeenCalledTimes(3); // Neither idempotent enqueue nor the worker renews the budget.
    expect(await f.service.retryTransientError('job-1', 'manual-1')).toBe(true);
    expect(f.state.jobs[0]).toMatchObject({ status: 'QUEUED', attemptCount: 3, attemptLimit: 6, nextAttemptAt: null });
    for (const ms of [90_000, 120_000, 180_000]) { jest.setSystemTime(CLOCK.getTime() + ms); await f.service.processQueue(); }
    expect(analyze).toHaveBeenCalledTimes(6);
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', attemptCount: 6, attemptLimit: 6, nextAttemptAt: null });
    expect(f.state.attempts.slice(0, 3)).toEqual(firstAttempts);
    expect(f.state.attempts.map(row => row.attemptNo)).toEqual([1, 2, 3, 4, 5, 6]);
    await f.service.processQueue(); expect(analyze).toHaveBeenCalledTimes(6);
    // A replay of the same backfill page is not another user request.
    expect(await f.service.retryTransientError('job-1', 'manual-1')).toBe(false);
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', attemptCount: 6, attemptLimit: 6 });
    expect(await f.service.retryTransientError('job-1', 'manual-2')).toBe(true);
    expect(f.state.jobs[0]).toMatchObject({ status: 'QUEUED', attemptCount: 6, attemptLimit: 9 });
    expect(f.state.grants.map(grant => [grant.requestKey, grant.attemptLimit])).toEqual([['manual-1', 6], ['manual-2', 9]]);
  });

  it('coalesces ten simultaneous manual retries into one budget extension', async () => {
    const f = fixture(); await f.enqueue();
    Object.assign(f.state.jobs[0], { status: 'ERROR', errorCode: 'LEASE_EXPIRED', attemptCount: 3, finishedAt: new Date() });
    const responses = await Promise.all(Array.from({ length: 10 }, () => new CrmControlAnalysisService(f.db).retryTransientError('job-1', 'manual-1')));
    expect(responses.filter(Boolean)).toHaveLength(1);
    expect(f.state.jobs[0]).toMatchObject({ status: 'QUEUED', attemptCount: 3, attemptLimit: 6 });
    expect(await f.service.retryTransientError('job-1', 'manual-1')).toBe(false);
    expect(f.state.jobs[0].attemptLimit).toBe(6);
    expect(f.state.grants).toHaveLength(1);
  });

  it('remembers grant A permanently after grant B and a worker restart', async () => {
    const f = fixture(); await f.enqueue();
    Object.assign(f.state.jobs[0], { status: 'ERROR', errorCode: 'LOCAL_AI_TIMEOUT', attemptCount: 3, finishedAt: new Date() });
    expect(await f.service.retryTransientError('job-1', 'request-A')).toBe(true);
    Object.assign(f.state.jobs[0], { status: 'ERROR', errorCode: 'LOCAL_AI_TIMEOUT', attemptCount: 6, finishedAt: new Date() });
    expect(await f.service.retryTransientError('job-1', 'request-B')).toBe(true);
    Object.assign(f.state.jobs[0], { status: 'ERROR', errorCode: 'LOCAL_AI_TIMEOUT', attemptCount: 9, finishedAt: new Date() });
    const restarted = new CrmControlAnalysisService(f.db);
    expect(await restarted.retryTransientError('job-1', 'request-A')).toBe(false);
    expect(await restarted.retryTransientError('job-1', 'request-B')).toBe(false);
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', attemptLimit: 9 });
    expect(f.state.grants).toHaveLength(2);
  });

  it.each(['P2002', 'DATABASE_UNAVAILABLE'])('rolls back the limit extension if grant persistence fails: %s', async code => {
    const f = fixture();
    await f.enqueue();
    Object.assign(f.state.jobs[0], { status: 'ERROR', errorCode: 'LOCAL_AI_TIMEOUT', attemptCount: 3, finishedAt: new Date() });
    f.db.crmControlAnalysisRetryGrant.create.mockRejectedValueOnce(Object.assign(new Error('grant write failed'), { code }));
    if (code === 'P2002') expect(await f.service.retryTransientError('job-1', 'request-A')).toBe(false);
    else await expect(f.service.retryTransientError('job-1', 'request-A')).rejects.toThrow('grant write failed');
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', attemptLimit: 3, attemptCount: 3 });
    expect(f.state.grants).toHaveLength(0);
  });

  it.each([
    ['READY', 'LOCAL_AI_TIMEOUT'], ['UNKNOWN', 'LOCAL_AI_TIMEOUT'], ['RUNNING', 'LOCAL_AI_TIMEOUT'],
    ['ERROR', 'LOCAL_AI_INVALID_RESPONSE'], ['ERROR', 'LOCAL_AI_IDENTITY_MISMATCH'], ['ERROR', 'LOCAL_AI_VERSION_CHANGED'],
  ])('does not retry %s / %s as a transient failure', async (status, errorCode) => {
    const f = fixture(); await f.enqueue();
    Object.assign(f.state.jobs[0], { status, errorCode, attemptCount: 3 });
    expect(await f.service.retryTransientError('job-1', 'manual-1')).toBe(false);
    expect(f.state.jobs[0].attemptLimit).toBe(3);
    expect(f.state.attempts).toHaveLength(0);
  });

  it('does not silently analyze old jobs with a changed model', async () => {
    const f = fixture(); await f.enqueue();
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = 'c'.repeat(64);
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze');
    await f.service.processQueue();
    expect(analyze).not.toHaveBeenCalled();
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', errorCode: 'LOCAL_AI_VERSION_CHANGED' });
  });

  it('retires only 100 outdated queued jobs and processes a current job in the same tick', async () => {
    const f = fixture(); await f.enqueue();
    const current = f.state.jobs[0];
    f.state.jobs.unshift(...Array.from({ length: 930 }, (_, index) => ({ ...clone(current), id: `old-${index}`, analyzerVersion: '1' })));
    const historicalAttempt = { jobId: 'old-0', attemptNo: 1, status: 'ERROR', errorCode: 'LOCAL_AI_IDENTITY_MISMATCH' };
    f.state.attempts.push(clone(historicalAttempt));
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => f.ready(input));
    await f.service.processQueue();
    expect(current).toMatchObject({ status: 'READY', analyzerVersion: CRM_CONTROL_ANALYZER_VERSION, attemptCount: 1 });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(f.state.jobs.filter(job => job.errorCode === 'LOCAL_AI_VERSION_CHANGED')).toHaveLength(100);
    expect(f.state.jobs.filter(job => job.analyzerVersion === '1' && job.status === 'QUEUED')).toHaveLength(830);
    expect(f.state.jobs.filter(job => job.analyzerVersion === '1').every(job => job.attemptCount === 0)).toBe(true);
    expect(f.state.attempts[0]).toEqual(historicalAttempt);
    expect(f.state.attempts).toHaveLength(2);
  });

  it('does not retire an outdated running request or rewrite completed errors and attempts', async () => {
    const f = fixture(); await f.enqueue();
    const running = { ...clone(f.state.jobs[0]), id: 'old-running', analyzerVersion: '1', status: 'RUNNING',
      activeKey: 'local-semantic', leaseToken: 'old-lease', leaseUntil: new Date(CLOCK.getTime() + 60_000), startedAt: CLOCK, attemptCount: 1 };
    const failed = { ...clone(f.state.jobs[0]), id: 'old-error', analyzerVersion: '1', status: 'ERROR',
      errorCode: 'LOCAL_AI_IDENTITY_MISMATCH', finishedAt: CLOCK, attemptCount: 1 };
    f.state.jobs.unshift(clone(running), clone(failed));
    f.state.attempts.push({ jobId: failed.id, attemptNo: 1, errorCode: failed.errorCode });
    const attempts = clone(f.state.attempts);
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze');
    await f.service.processQueue();
    expect(f.state.jobs[0]).toEqual(running); expect(f.state.jobs[1]).toEqual(failed);
    expect(f.state.attempts).toEqual(attempts); expect(analyze).not.toHaveBeenCalled();
  });

  it('does not retire a queued job that another worker claimed before the retirement CAS', async () => {
    const f = fixture(); await f.enqueue(); f.state.jobs[0].analyzerVersion = '1';
    const updateMany = f.db.crmControlAnalysisJob.updateMany.getMockImplementation();
    f.db.crmControlAnalysisJob.updateMany.mockImplementationOnce(async (args: any) => {
      Object.assign(f.state.jobs[0], { status: 'RUNNING', activeKey: 'local-semantic', leaseToken: 'concurrent',
        leaseUntil: new Date(CLOCK.getTime() + 60_000), startedAt: CLOCK, attemptCount: 1 });
      return updateMany(args);
    });
    await f.service.processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'RUNNING', errorCode: null, finishedAt: null, leaseToken: 'concurrent' });
    expect(f.state.attempts).toHaveLength(0);
  });

  it('permits only one active request across service instances and different jobs', async () => {
    const f = fixture(); await f.enqueue();
    f.state.jobs.push({ ...clone(f.state.jobs[0]), id: 'job-2', inputHash: 'c'.repeat(64) });
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => {
      started(); await new Promise<void>(resolve => { finish = resolve; }); return f.ready(input);
    });
    const running = f.service.processQueue(); await begun;
    await new CrmControlAnalysisService(f.db).processQueue();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(f.state.jobs.filter(row => row.status === 'RUNNING')).toHaveLength(1);
    expect(f.state.jobs[1].attemptCount).toBe(0);
    finish(); await running;
  });

  it('records an expired attempt and fences the late writer after a replacement finishes', async () => {
    const f = fixture(); await f.enqueue();
    let started!: () => void, finishOld!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze')
      .mockImplementationOnce(async input => { started(); await new Promise<void>(resolve => { finishOld = resolve; }); return f.ready(input); })
      .mockImplementation(async input => f.ready(input));
    const old = f.service.processQueue(); await begun;
    jest.setSystemTime(CLOCK.getTime() + 5 * 60_000 + 1);
    await new CrmControlAnalysisService(f.db).processQueue();
    expect(f.state.jobs[0]).toMatchObject({ status: 'READY', attemptCount: 2 });
    expect(f.state.attempts.map(row => [row.attemptNo, row.status, row.errorCode])).toEqual([[1, 'ERROR', 'LEASE_EXPIRED'], [2, 'READY', null]]);
    const preserved = clone(f.state);
    finishOld(); await old;
    expect(f.state).toEqual(preserved);
  });

  it('stops recovering a repeatedly crashed job after its third lease', async () => {
    const f = fixture(); await f.enqueue();
    Object.assign(f.state.jobs[0], { status: 'RUNNING', activeKey: 'local-semantic', leaseToken: 'third-lease',
      attemptCount: 3, startedAt: new Date(CLOCK.getTime() - 360_000), leaseUntil: new Date(CLOCK.getTime() - 1) });
    const analyze = jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze');
    await f.service.processQueue();
    expect(analyze).not.toHaveBeenCalled();
    expect(f.state.jobs[0]).toMatchObject({ status: 'ERROR', activeKey: null, attemptCount: 3, nextAttemptAt: null });
    expect(f.state.attempts).toEqual([expect.objectContaining({ attemptNo: 3, errorCode: 'LEASE_EXPIRED', retryable: false })]);
  });

  it('rolls back completion when the append-only attempt cannot be persisted', async () => {
    const f = fixture(); await f.enqueue();
    jest.spyOn(CrmControlLocalSemanticClient.prototype, 'analyze').mockImplementation(async input => f.ready(input));
    f.db.crmControlAnalysisAttempt.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.service.processQueue()).rejects.toThrow('database unavailable');
    expect(f.state.jobs[0].status).toBe('RUNNING');
    expect(f.state.attempts).toHaveLength(0);
  });
});
