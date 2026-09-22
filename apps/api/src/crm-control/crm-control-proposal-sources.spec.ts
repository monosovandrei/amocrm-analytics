import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CrmControlProposalSourceCollector } from './crm-control-proposal-sources';

describe('private proposal source archive', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'crm-proposal-test-')); });
  afterEach(async () => {
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  });
  const bytes = Buffer.from('%PDF-test');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileUuid = '11111111-1111-4111-a111-111111111111';
  const versionUuid = '22222222-2222-4222-a222-222222222222';
  const url = `https://drive-b.amocrm.ru/download/${fileUuid}/${versionUuid}/offer.pdf`;
  const fields = [{ field_id: 77, values: [{ value: { file_uuid: fileUuid, version_uuid: versionUuid, file_name: '../../danger.pdf' } }] }];
  const message = (overrides: any = {}) => ({ bindingProof: { kind: 'webhook_entity', sourceReference: 'inbox:1' }, message: {
    eligibleAsOutgoingEvidence: true, messageId: 'message:1', occurredAt: new Date('2026-09-22T08:00:00Z'),
    attachments: [{ url, name: 'offer.pdf' }], ...overrides,
  } }) as any;

  test('archives actual bytes once, preserving field version and outgoing message identity', async () => {
    const download = jest.fn().mockResolvedValue({ bytes, size: bytes.length, sha256, contentType: 'application/pdf' });
    const drive = { resolve: jest.fn().mockResolvedValue({ downloadUrl: url }) } as any;
    const result = await new CrmControlProposalSourceCollector(drive, directory, download).collect(fields, '77', [message()]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(result.fieldFiles[0]).toMatchObject({ fileUuid, versionUuid, artifact: { sha256, storageKey: `${sha256}.bin` } });
    expect(result.sentAttachments[0]).toMatchObject({ messageId: 'message:1', artifact: { sha256 } });
    expect(await readFile(path.join(directory, `${sha256}.bin`))).toEqual(bytes);
    expect(result.sentHistoryComplete).toBe(false);
    expect(await readdir(directory)).toEqual([`${sha256}.bin`]);
  });

  test('unverified messages cannot become evidence of sending', async () => {
    const download = jest.fn();
    const result = await new CrmControlProposalSourceCollector(null, directory, download).collect([], '77', [message({ eligibleAsOutgoingEvidence: false })]);
    expect(download).not.toHaveBeenCalled();
    expect(result.sentAttachments).toEqual([]);
    expect(result.sentHistoryComplete).toBe(false);
  });

  test('records missing access, without inventing archived files or a complete history', async () => {
    const result = await new CrmControlProposalSourceCollector(null, directory).collect(fields, '77', []);
    expect(result.fieldFiles[0]).toMatchObject({ errorCode: 'DOCUMENT_SOURCE_UNAVAILABLE' });
    expect(result.fieldFiles[0].artifact).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  test('sanitizes arbitrary transport errors containing private URLs', async () => {
    const download = jest.fn().mockRejectedValue(new Error('request failed: https://private.test?token=secret'));
    const result = await new CrmControlProposalSourceCollector(null, directory, download).collect([], '77', [message()]);
    expect(result.sentAttachments[0].errorCode).toBe('DOCUMENT_SOURCE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('bounds the number of attachments per deal and marks every skipped file', async () => {
    const download = jest.fn().mockResolvedValue({ bytes, size: bytes.length, sha256, contentType: 'application/pdf' });
    const messages = Array.from({ length: 35 }, (_, index) => message({ messageId: `message:${index}` }));
    const result = await new CrmControlProposalSourceCollector(null, directory, download).collect([], '77', messages);
    expect(result.sentAttachments.filter(item => item.artifact)).toHaveLength(32);
    expect(result.sentAttachments.filter(item => item.errorCode === 'FILE_COLLECTION_LIMIT')).toHaveLength(3);
    expect(result.problems).toContain('FILE_COLLECTION_LIMIT');
    expect(result.sentHistoryComplete).toBe(false);
  });

  test('does not start Drive reads or downloads after the collection deadline', async () => {
    const controller = new AbortController(); controller.abort();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const drive = { resolve: jest.fn() } as any;
    const download = jest.fn();
    try {
      const result = await new CrmControlProposalSourceCollector(drive, directory, download).collect(fields, '77', [message()]);
      expect(drive.resolve).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      expect(result.fieldFiles[0].errorCode).toBe('FILE_COLLECTION_LIMIT');
      expect(result.sentAttachments[0].errorCode).toBe('FILE_COLLECTION_LIMIT');
    } finally { timeout.mockRestore(); }
  });
});
