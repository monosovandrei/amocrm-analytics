import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CrmControlDocumentAnalysisService } from './crm-control-document-analysis.service';
import { crmControlDocumentEvidence, readCrmControlDocument, readCrmControlPrivateArtifact } from './crm-control-document-evidence';
import { CrmControlLocalExtractionClient } from './crm-control-local-extraction.client';
import { CrmControlService } from './crm-control.service';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const source = Buffer.from('%PDF-synthetic-test');
const sha256 = hash(source);
const artifact = { sha256, storageKey: `${sha256}.bin`, contentType: 'application/pdf', size: source.length, capturedAt: '2026-09-22T10:00:00Z' };
const proposal = (values: any[] = [{ artifact }]) => ({ fieldFiles: values, sentAttachments: [], fieldReadComplete: true, fieldId: 'synthetic', problems: [], sentHistoryComplete: false as const });

describe('private document archive and analysis boundary', () => {
  let directory: string, old: Record<string, string | undefined>;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'crm-document-'));
    old = Object.fromEntries(['CRM_CONTROL_DOCUMENT_DIR', 'CRM_CONTROL_LOCAL_SCRIPTS_DIR', 'CRM_CONTROL_PYTHON'].map(key => [key, process.env[key]]));
    Object.assign(process.env, { CRM_CONTROL_DOCUMENT_DIR: directory, CRM_CONTROL_LOCAL_SCRIPTS_DIR: directory, CRM_CONTROL_PYTHON: process.execPath });
    await writeFile(path.join(directory, artifact.storageKey), source, { mode: 0o600 });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  it('excludes contact/unbound mail and malformed artifacts from public proof lists', () => {
    const proof = crmControlDocumentEvidence({ proposalSources: { fieldFiles: [null, { artifact }, { artifact: { ...artifact, storageKey: '../secret' } }] },
      browserSources: { documents: [null, { binding: 'NOT_BOUND', artifact: { ...artifact, sha256: 'a'.repeat(64), storageKey: `${'a'.repeat(64)}.bin` } }, { binding: 'DEAL', artifact }] } });
    expect(proof.map(item => [item.sha256, item.source])).toEqual([[sha256, 'field'], [sha256, 'sent']]);
    expect(JSON.stringify(proof)).not.toContain('storageKey');
  });
  it('reads exact content-addressed bytes and rejects a stale hash or size', async () => {
    const proof = { ...artifact, source: 'field' as const, label: 'synthetic' };
    expect((await readCrmControlDocument(directory, proof)).buffer).toEqual(source);
    await expect(readCrmControlDocument(directory, { ...proof, size: source.length + 1 })).rejects.toThrow();
    await writeFile(path.join(directory, artifact.storageKey), Buffer.from('%PDF-corrupted-test'));
    await expect(readCrmControlDocument(directory, proof)).rejects.toThrow();
  });
  it.each(['../secret', '/secret', 'nested/../../secret', 'nested\\secret'])('rejects private path escape %s', async key => {
    await expect(readCrmControlPrivateArtifact(directory, key, sha256, 100)).rejects.toThrow();
  });
  it('rejects a symlink in the extraction parent directory', async () => {
    const actual = path.join(directory, 'actual'); await mkdir(actual);
    const extracted = path.join(directory, '.extracted');
    // Junctions are available without Windows symlink privilege and have the same unsafe ancestor semantics.
    await symlink(actual, extracted, process.platform === 'win32' ? 'junction' : 'dir');
    const version = path.join(actual, 'local-documents-v1'); await mkdir(version);
    const payload = JSON.stringify({ extractorVersion: 'local-documents-v1', sourceSha256: sha256, status: 'COMPLETE', units: [], problems: [] });
    const outputSha256 = hash(payload), storageKey = `local-documents-v1/${sha256}.${outputSha256}.json`;
    await writeFile(path.join(version, `${sha256}.${outputSha256}.json`), payload);
    await expect(new CrmControlDocumentAnalysisService().read({ sourceSha256: sha256, status: 'COMPLETE', issues: [], outputSha256, storageKey })).rejects.toThrow();
  });
  it('reads only a matching immutable extraction reference', async () => {
    const folder = path.join(directory, '.extracted/local-documents-v1'); await mkdir(folder, { recursive: true });
    const payload = JSON.stringify({ extractorVersion: 'local-documents-v1', sourceSha256: sha256, status: 'COMPLETE', units: [], problems: [] });
    const outputSha256 = hash(payload), storageKey = `local-documents-v1/${sha256}.${outputSha256}.json`;
    await writeFile(path.join(folder, `${sha256}.${outputSha256}.json`), payload);
    const reference = { sourceSha256: sha256, status: 'COMPLETE' as const, issues: [], outputSha256, storageKey };
    expect(await new CrmControlDocumentAnalysisService().read(reference)).toMatchObject({ sourceSha256: sha256 });
    await expect(new CrmControlDocumentAnalysisService().read({ ...reference, status: 'UNVERIFIED' })).rejects.toThrow();
  });
  it('deduplicates the same bytes and never extracts NOT_BOUND mail', async () => {
    const extract = jest.spyOn(CrmControlLocalExtractionClient.prototype, 'extract').mockResolvedValue({ status: 'ERROR', code: 'LOCAL_SOURCE_REJECTED', retryable: false });
    const browser = { documents: [{ binding: 'NOT_BOUND', artifact: { ...artifact, sha256: 'a'.repeat(64), storageKey: `${'a'.repeat(64)}.bin` } }, { binding: 'DEAL', artifact }] } as any;
    const result = await new CrmControlDocumentAnalysisService().collect(proposal() as any, browser);
    expect(result.documents).toHaveLength(1); expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0].sha256).toBe(sha256);
  });
  it('serializes concurrent deal collection without a second child', async () => {
    let resolveFirst!: (value: any) => void;
    const extract = jest.spyOn(CrmControlLocalExtractionClient.prototype, 'extract')
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue({ status: 'ERROR', code: 'LOCAL_SOURCE_REJECTED', retryable: false });
    const service = new CrmControlDocumentAnalysisService();
    const first = service.collect(proposal() as any, null), second = service.collect(proposal() as any, null);
    await Promise.resolve(); await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);
    resolveFirst({ status: 'ERROR', code: 'LOCAL_SOURCE_REJECTED', retryable: false });
    await Promise.all([first, second]); expect(extract).toHaveBeenCalledTimes(2);
  });
  it('limits extraction to 32 files while recording every unprocessed reference', async () => {
    const extract = jest.spyOn(CrmControlLocalExtractionClient.prototype, 'extract').mockResolvedValue({ status: 'ERROR', code: 'LOCAL_SOURCE_REJECTED', retryable: false });
    const values = Array.from({ length: 34 }, (_, index) => { const sha256 = hash(String(index)); return { artifact: { ...artifact, sha256, storageKey: `${sha256}.bin` } }; });
    const output = await new CrmControlDocumentAnalysisService().collect(proposal(values) as any, null);
    expect(extract).toHaveBeenCalledTimes(32); expect(output.documents).toHaveLength(34);
    expect(output.documents.slice(32).every(item => item.issues.includes('DOCUMENT_ANALYSIS_LIMIT'))).toBe(true);
  });
  it('keeps missing configuration explicit without spawning', async () => {
    delete process.env.CRM_CONTROL_PYTHON;
    const extract = jest.spyOn(CrmControlLocalExtractionClient.prototype, 'extract');
    expect((await new CrmControlDocumentAnalysisService().collect(proposal() as any, null)).documents[0].issues).toEqual(['LOCAL_EXTRACTION_NOT_CONFIGURED']);
    expect(extract).not.toHaveBeenCalled();
  });
  it('checks observation ACL before reading documents and rejects a hash from another observation', async () => {
    const service = new CrmControlService({} as any, {} as any, {} as any);
    const access = jest.spyOn(service as any, 'visibleObservation').mockRejectedValue(new Error('ACL_REJECTED'));
    await expect(service.documentEvidence({ id: 'manager' } as any, 'other-observation', sha256)).rejects.toThrow('ACL_REJECTED');
    access.mockResolvedValue({ row: { snapshot: { proposalSources: proposal() } } });
    await expect(service.documentEvidence({ id: 'manager' } as any, 'own-observation', '0'.repeat(64))).rejects.toMatchObject({ status: 404 });
    expect((await service.documentEvidence({ id: 'manager' } as any, 'own-observation', sha256)).buffer).toEqual(source);
  });
});
