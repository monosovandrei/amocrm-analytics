import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CrmControlBrowserSourceService, parseCrmBrowserAccountCurrency } from './crm-control-browser-source.service';
import { BrowserHistoryError, createCrmBrowserHistoryReader } from './crm-control-browser-history';
import { CrmSourceAuthExpiredError } from './crm-control-evidence.service';
import { downloadMailAttachment } from './crm-control-browser-files';

jest.mock('./crm-control-browser-history', () => ({ ...jest.requireActual('./crm-control-browser-history'), createCrmBrowserHistoryReader: jest.fn() }));
jest.mock('./crm-control-browser-files', () => ({ ...jest.requireActual('./crm-control-browser-files'), downloadMailAttachment: jest.fn() }));
const time = '2026-09-22T10:00:00.000Z';
const pdf = Buffer.from('%PDF-1.4\nFixture only');
const job = (id = '123') => ({ dealExternalId: id, sourceUrl: `https://test.amocrm.ru/leads/detail/${id}` });
const message = (metadataHash = 'metadata') => ({ id: '8', sent: true, occurredAt: time, content: 'PRIVATE TEST MESSAGE BODY', subject: 'PRIVATE TEST SUBJECT',
  attachments: [{ id: '91', sourceHash: metadataHash, name: 'test.pdf', downloadBlocked: false, state: null }] });

describe('browser source batch/private manifest', () => {
  let folder: string, oldDirectory: string | undefined, service: CrmControlBrowserSourceService, prepare: jest.Mock;
  let history: any, currencyValues: any;
  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'crm-browser-source-'));
    oldDirectory = process.env.CRM_CONTROL_DOCUMENT_DIR; process.env.CRM_CONTROL_DOCUMENT_DIR = folder;
    history = { dealExternalId: '123', entries: [], threads: [{ id: '7', binding: 'RELATED_ENTITY', messages: [message()] }],
      communicationsComplete: false, reasonCodes: ['ALL_CHANNEL_COVERAGE_UNPROVEN'], startedAt: time, finishedAt: time };
    prepare = jest.fn().mockResolvedValue({ downloadUrl: 'https://private-signed-url.example' });
    (createCrmBrowserHistoryReader as jest.Mock).mockReset().mockImplementation((_context, input) => ({
      collect: async () => ({ ...structuredClone(history), dealExternalId: input.dealExternalId }), dispose: jest.fn(), prepareAttachment: prepare,
    }));
    (downloadMailAttachment as jest.Mock).mockReset().mockResolvedValue({ bytes: pdf, sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.length, contentType: 'application/pdf' });
    currencyValues = { accountCode: 'EUR', localeCode: 'EUR' };
    const evidence = { withSourceBatch: async (action: any) => ({ ok: true, value: await action({ readSources: async (_job: any, make: any) => {
      const reader = make({ context: {}, origin: 'https://test.amocrm.ru', mailAccountId: '42', currencyValues, currencyObservedAt: time });
      try { return { ok: true, value: await reader.collect() }; } finally { reader.dispose(); }
    } }) }) };
    service = new CrmControlBrowserSourceService(evidence as any);
  });
  afterEach(async () => {
    if (oldDirectory === undefined) delete process.env.CRM_CONTROL_DOCUMENT_DIR; else process.env.CRM_CONTROL_DOCUMENT_DIR = oldDirectory;
    const absolute = path.resolve(folder);
    if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith('crm-browser-source-')) await rm(absolute, { recursive: true, force: true });
  });

  it('archives the original bytes and private history, returning only source references to the snapshot', async () => {
    const result = await service.withBatch(batch => batch.collectCurrent(job()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    const bundle = result.value;
    expect(bundle.documents[0]).toMatchObject({ binding: 'NOT_BOUND', bindingReason: 'UNVERIFIED', messageId: '8', attachmentId: '91',
      artifact: { sha256: createHash('sha256').update(pdf).digest('hex'), contentType: 'application/pdf' } });
    expect(JSON.stringify(bundle)).not.toContain('PRIVATE TEST');
    expect(JSON.stringify(bundle)).not.toContain('private-signed-url');
    const stored = await service.readManifest(bundle.manifest!, '123');
    expect(bundle.accountCurrency).toMatchObject({ status: 'VERIFIED', code: 'EUR', source: 'AMOCRM.constant(account).currency', observedAt: time });
    expect(stored.accountCurrency).toEqual(bundle.accountCurrency);
    expect(stored.history.threads[0].messages[0].content).toBe('PRIVATE TEST MESSAGE BODY');
    expect(await readFile(path.join(folder, bundle.documents[0].artifact!.storageKey))).toEqual(pdf);
  });

  it.each([
    [{ accountCode: 'EUR', localeCode: 'eur' }, 'VERIFIED', 'EUR'],
    [{ accountCode: 'EUR', localeCode: 'USD' }, 'CONFLICT', null],
    [{ accountCode: null, localeCode: 'EUR' }, 'UNAVAILABLE', null],
    [{ accountCode: 'EUR', localeCode: null }, 'UNAVAILABLE', null],
    [{ accountCode: 'ZZZ', localeCode: 'ZZZ' }, 'UNAVAILABLE', null],
    [{ accountCode: '€', localeCode: 'EUR' }, 'UNAVAILABLE', null],
  ])('accepts only matching ISO account authority and UI locale: %j', (raw, status, code) => {
    expect(parseCrmBrowserAccountCurrency(raw, time)).toMatchObject({ status, code, observedAt: time });
  });

  it('keeps history usable while an unavailable bootstrap currency stays explicit', async () => {
    currencyValues = { accountCode: null, localeCode: null };
    const result = await service.withBatch(batch => batch.collectCurrent(job()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.manifest).toBeDefined();
    expect(result.value.accountCurrency).toMatchObject({ status: 'UNAVAILABLE', code: null });
    expect(result.value.reasonCodes).toContain('ACCOUNT_CURRENCY_UNAVAILABLE');
    expect(JSON.stringify(result.value)).not.toContain('secret');
  });

  it('does not select either currency when account authority and locale conflict', async () => {
    currencyValues = { accountCode: 'EUR', localeCode: 'USD' };
    const result = await service.withBatch(batch => batch.collectCurrent(job()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.accountCurrency).toMatchObject({ status: 'CONFLICT', code: null, accountCode: 'EUR', localeCode: 'USD' });
    expect(result.value.reasonCodes).toContain('ACCOUNT_CURRENCY_CONFLICT');
  });

  it('propagates a history401 so the provider restarts the whole source reader after native refresh', async () => {
    (createCrmBrowserHistoryReader as jest.Mock).mockReturnValueOnce({ collect: async () => { throw new BrowserHistoryError('HISTORY_AUTH_EXPIRED'); }, dispose: jest.fn() });
    await expect(service.withBatch(batch => batch.collectCurrent(job()))).rejects.toBeInstanceOf(CrmSourceAuthExpiredError);
    expect(downloadMailAttachment).not.toHaveBeenCalled();
  });

  it('propagates an attachment preparation401 instead of storing a partial manifest as the finished read', async () => {
    prepare.mockRejectedValueOnce(new BrowserHistoryError('HISTORY_AUTH_EXPIRED'));
    await expect(service.withBatch(batch => batch.collectCurrent(job()))).rejects.toBeInstanceOf(CrmSourceAuthExpiredError);
  });

  it('uses exact message-level timeline binding without attaching the rest of a contact thread to the deal', async () => {
    history.entries = [{ id: 'note-uuid', binding: 'DEAL', mail: { threadId: '7', messageId: '8' } }];
    history.threads[0].messages.push({ ...message('second'), id: '9' });
    const result = await service.withBatch(batch => batch.collectCurrent(job()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.documents.map(item => item.binding)).toEqual(['DEAL', 'NOT_BOUND']);
    expect(result.value.documents[0].sourceEntryIds).toEqual(['note-uuid']);
  });

  it('reuses identical attachment identity+metadata within the batch, recomputing binding for each deal', async () => {
    const result = await service.withBatch(async batch => {
      history.entries = [{ id: 'note-uuid', binding: 'DEAL', mail: { threadId: '7', messageId: '8' } }];
      const first = await batch.collectCurrent(job()); history.entries = [];
      const second = await batch.collectCurrent(job('456')); return [first, second];
    });
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(downloadMailAttachment).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.value.map(item => item.documents[0].binding)).toEqual(['DEAL', 'NOT_BOUND']);
    expect(result.value[0].documents[0].artifact).toEqual(result.value[1].documents[0].artifact);
  });

  it('does not reuse a file when the attachment metadata hash changes', async () => {
    await service.withBatch(async batch => { await batch.collectCurrent(job()); history.threads[0].messages = [message('changed')]; await batch.collectCurrent(job()); });
    expect(downloadMailAttachment).toHaveBeenCalledTimes(2);
  });

  it('refuses foreign-deal, traversal and corrupted manifest reads', async () => {
    const result = await service.withBatch(batch => batch.collectCurrent(job(), { collectAttachments: false }));
    if (!result.ok) throw Error('Unexpected fixture failure');
    const reference = result.value.manifest!;
    await expect(service.readManifest(reference, '456')).rejects.toThrow('HISTORY_MANIFEST_INVALID');
    await expect(service.readManifest({ ...reference, storageKey: '../outside' }, '123')).rejects.toThrow('HISTORY_MANIFEST_INVALID');
    await writeFile(path.join(folder, reference.storageKey), 'corrupt');
    await expect(service.readManifest(reference, '123')).rejects.toThrow('HISTORY_MANIFEST_INVALID');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps failed attachment preparation visible without sending URLs or transport error details to the API', async () => {
    prepare.mockRejectedValueOnce(new Error('cookie=secret; https://private/attachment'));
    const result = await service.withBatch(batch => batch.collectCurrent(job()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.documents[0]).toMatchObject({ errorCode: 'HISTORY_SOURCE_UNAVAILABLE' });
    expect(result.value.documents[0].artifact).toBeUndefined();
    expect(JSON.stringify(result.value)).not.toContain('secret');
  });
});
