import path from 'node:path';
import { CRM_CONTROL_ANALYZER_VERSION } from './crm-control-analysis.service';
import { CRM_CONTROL_LOCAL_PROMPT_VERSION } from './crm-control-local-semantic.client';
import { CRM_CONTROL_SEMANTIC_POLICY_VERSION } from './crm-control-semantic.policy';
import { CrmControlAnalysisSummary, crmControlAnalysisProjection, crmControlAnalysisSummarySelect } from './crm-control-analysis.projection';

const ENV = ['CRM_CONTROL_LOCAL_AI_ORIGIN', 'CRM_CONTROL_LOCAL_AI_MODEL', 'CRM_CONTROL_LOCAL_AI_MODEL_SHA256',
  'CRM_CONTROL_LOCAL_AI_CACHE_DIR', 'CRM_CONTROL_LOCAL_AI_TIMEOUT_MS'] as const;

describe('analysis projection identity and privacy', () => {
  const original = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  beforeEach(() => {
    process.env.CRM_CONTROL_LOCAL_AI_ORIGIN = 'http://127.0.0.1:8091';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL = 'qualified-local-model';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = 'a'.repeat(64);
    process.env.CRM_CONTROL_LOCAL_AI_CACHE_DIR = path.resolve('tmp/semantic-cache-test');
    delete process.env.CRM_CONTROL_LOCAL_AI_TIMEOUT_MS;
  });
  afterEach(() => { for (const key of ENV) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; });
  const job = (): CrmControlAnalysisSummary => ({ id: 'job-1', status: 'READY', assessmentStatus: 'PASS', assessmentMessage: 'Подтверждено.',
    policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION, model: 'qualified-local-model', modelSha256: 'a'.repeat(64),
    analyzerVersion: CRM_CONTROL_ANALYZER_VERSION, promptVersion: CRM_CONTROL_LOCAL_PROMPT_VERSION,
    errorCode: null, attemptCount: 1, createdAt: new Date(), finishedAt: new Date() });

  it.each(['PASS', 'FAIL'])('accepts %s only for the exact currently configured identity', assessmentStatus => {
    expect(crmControlAnalysisProjection([{ ...job(), assessmentStatus }])).toMatchObject({ outcome: assessmentStatus, message: 'Подтверждено.' });
  });

  it.each(['model', 'modelSha256', 'analyzerVersion', 'promptVersion', 'policyVersion'] as const)('does not count an old %s result as checked', field => {
    const stale = { ...job(), [field]: 'old-version' };
    expect(crmControlAnalysisProjection([stale])).toMatchObject({ outcome: null, message: expect.stringContaining('другой версией') });
    expect(crmControlAnalysisProjection([stale])?.message).not.toBe(stale.assessmentMessage);
  });
  it.each(['PASS', 'FAIL'])('retires analyzer2 terminal %s conclusions under the new empty-source/call policy', assessmentStatus => {
    expect(CRM_CONTROL_ANALYZER_VERSION).toBe('4');
    expect(crmControlAnalysisProjection([{ ...job(), analyzerVersion: '2', assessmentStatus }])?.outcome).toBeNull();
  });

  it('invalidates a previously accepted conclusion immediately when the configured model changes', () => {
    const previous = job();
    expect(crmControlAnalysisProjection([previous])?.outcome).toBe('PASS');
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = 'b'.repeat(64);
    expect(crmControlAnalysisProjection([previous])?.outcome).toBeNull();
    expect(crmControlAnalysisProjection([{ ...previous, modelSha256: 'b'.repeat(64) }])?.outcome).toBe('PASS');
  });

  it('does not trust a saved positive result without a valid local runtime configuration', () => {
    delete process.env.CRM_CONTROL_LOCAL_AI_ORIGIN;
    expect(crmControlAnalysisProjection([job()])).toMatchObject({ outcome: null, message: expect.stringContaining('не настроен') });
    process.env.CRM_CONTROL_LOCAL_AI_ORIGIN = 'https://external.example';
    expect(crmControlAnalysisProjection([job()])?.outcome).toBeNull();
  });

  it.each(['QUEUED', 'RUNNING', 'UNKNOWN', 'ERROR'])('does not accept a cached assessment while the job is %s', status => {
    expect(crmControlAnalysisProjection([{ ...job(), status }])?.outcome).toBeNull();
  });

  it('does not use an older positive result while a newer job is unresolved', () => {
    expect(crmControlAnalysisProjection([{ ...job(), id: 'new', status: 'UNKNOWN' }, job()])?.outcome).toBeNull();
  });

  it('keeps raw requests, sources, transcripts and responses outside the compact query and public projection', () => {
    expect(Object.keys(crmControlAnalysisSummarySelect).sort()).toEqual(['analyzerVersion', 'assessmentMessage', 'assessmentStatus', 'attemptCount',
      'createdAt', 'errorCode', 'finishedAt', 'id', 'model', 'modelSha256', 'policyVersion', 'promptVersion', 'status'].sort());
    const extra = { ...job(), request: { secret: 'customer-text' }, attempts: [{ rawResponse: { secret: 'customer-text' } }] };
    expect(JSON.stringify(crmControlAnalysisProjection([extra]))).not.toContain('customer-text');
    expect(crmControlAnalysisProjection([extra])).not.toHaveProperty('modelSha256');
  });
});
