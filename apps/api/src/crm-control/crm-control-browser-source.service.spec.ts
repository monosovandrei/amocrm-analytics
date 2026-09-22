import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CrmControlBrowserSourceService, parseCrmBrowserAccountCurrency } from './crm-control-browser-source.service';
import { BrowserHistoryError, createCrmBrowserHistoryReader } from './crm-control-browser-history';
import { CrmSourceAuthExpiredError } from './crm-control-evidence.service';
import { downloadMailAttachment } from './crm-control-browser-files';
import { readEmptyCrmChatHistory } from './crm-control-chat-empty';
import { createCrmControlChatNative } from './crm-control-chat-native';

jest.mock('./crm-control-browser-history', () => ({ ...jest.requireActual('./crm-control-browser-history'), createCrmBrowserHistoryReader: jest.fn() }));
jest.mock('./crm-control-browser-files', () => ({ ...jest.requireActual('./crm-control-browser-files'), downloadMailAttachment: jest.fn() }));
jest.mock('./crm-control-chat-empty', () => ({ readEmptyCrmChatHistory: jest.fn() }));
jest.mock('./crm-control-chat-native', () => ({ createCrmControlChatNative: jest.fn() }));
const time = '2026-09-22T10:00:00.000Z';
const pdf = Buffer.from('%PDF-1.4\nFixture only');
const job = (id = '123') => ({ dealExternalId: id, sourceUrl: `https://test.amocrm.ru/leads/detail/${id}` });
const chatJob = (patch = {}) => ({ ...job(), connectionId: 'connection-1', accountExternalId: '42', ...patch });
const message = (metadataHash = 'metadata') => ({ id: '8', sent: true, occurredAt: time, content: 'PRIVATE TEST MESSAGE BODY', subject: 'PRIVATE TEST SUBJECT',
  attachments: [{ id: '91', sourceHash: metadataHash, name: 'test.pdf', downloadBlocked: false, state: null }] });

describe('browser source batch/private manifest', () => {
  let folder: string, oldDirectory: string | undefined, service: CrmControlBrowserSourceService, prepare: jest.Mock;
  let history: any, currencyValues: any, accountExternalId: string | null, browser: any, native: any, historyCollect: jest.Mock;
  const capture = (value: unknown, httpStatus = 200) => ({ value, httpStatus, capturedAt: new Date().toISOString() });
  const chatTalk = () => ({ talk_id: 11, account_id: 42, chat_id: 'chat-1', contact_id: 55, entity_type: 'lead', entity_id: 123,
    _embedded: { contacts: [{ id: 55 }], leads: [{ id: 123 }], customers: [] } });
  let chatMessages: any[];
  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'crm-browser-source-'));
    oldDirectory = process.env.CRM_CONTROL_DOCUMENT_DIR; process.env.CRM_CONTROL_DOCUMENT_DIR = folder;
    history = { dealExternalId: '123', entries: [], threads: [{ id: '7', binding: 'RELATED_ENTITY', messages: [message()] }],
      communicationsComplete: false, reasonCodes: ['ALL_CHANNEL_COVERAGE_UNPROVEN'], startedAt: time, finishedAt: time };
    prepare = jest.fn().mockResolvedValue({ downloadUrl: 'https://private-signed-url.example' });
    historyCollect = jest.fn(async (input: any) => ({ ...structuredClone(history), dealExternalId: input.dealExternalId }));
    (createCrmBrowserHistoryReader as jest.Mock).mockReset().mockImplementation((_context, input) => ({
      collect: () => historyCollect(input), dispose: jest.fn(), prepareAttachment: prepare,
    }));
    (downloadMailAttachment as jest.Mock).mockReset().mockResolvedValue({ bytes: pdf, sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.length, contentType: 'application/pdf' });
    currencyValues = { accountCode: 'EUR', localeCode: 'EUR' };
    accountExternalId = '42';
    chatMessages = [{ id: 'chat-message-1', chat_id: 'chat-1', dialog: { id: 11 }, created_at: 1700000000,
      author: { id: 'customer-1', bot: false }, recipient: { id: 'staff-1', bot: false },
      message: { type: 'text', text: 'PRIVATE SYNTHETIC CUSTOMER CHAT: agreed 25.09.2026' } }];
    native = { accountMetadata: { accountExternalId: '42', amojoAccountId: 'account-chat-42', amojoOrigin: 'https://amojo.amocrm.ru',
      capturedAt: new Date().toISOString(), accountUsers: [{ amojoId: 'staff-1', crmUserId: '101' }], accountUserCatalogAvailable: true },
      transport: {
        listTalks: jest.fn(async () => capture({ _embedded: { talks: [chatTalk()] } })),
        listRelatedChats: jest.fn(async () => capture({ _embedded: { chats: [{ chat_id: 'chat-1', entity_id: 55, entity_type: 1 }] } })),
        readMessages: jest.fn(async (_chatId: string, offset: number, limit: number) => capture(structuredClone(chatMessages.slice(offset, offset + limit)))),
        readCount: jest.fn(async () => chatMessages.length), readTalk: jest.fn(async () => capture(chatTalk())),
      }, readNativeExternalTargets: jest.fn().mockResolvedValue([{ chatId: 'chat-1', contactId: '55', amojoId: 'customer-1' }]) };
    (createCrmControlChatNative as jest.Mock).mockReset().mockResolvedValue(native);
    (readEmptyCrmChatHistory as jest.Mock).mockReset().mockResolvedValue(null);
    browser = { readSources: jest.fn(async (_job: any, make: any) => {
      const reader = make({ context: {}, origin: 'https://test.amocrm.ru', mailAccountId: '42', accountExternalId, currencyValues, currencyObservedAt: time });
      try { return { ok: true, value: await reader.collect() }; } finally { reader.dispose(); }
    }), readCard: jest.fn(async (_job: any, make: any) => {
      const reader = make({ fixturePage: true });
      try { return { ok: true, value: await reader.collect() }; }
      catch (error) { return { ok: false, errorCode: error instanceof CrmSourceAuthExpiredError ? 'AUTH_REQUIRED' : 'CAPTURE_FAILED', message: 'Safe fixture error', retryable: false }; }
      finally { reader.dispose(); }
    }) };
    const evidence = { withSourceBatch: async (action: any) => ({ ok: true, value: await action(browser) }) };
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

  it('uses the twice-verified empty chat inventory under the exact account scope without rendering a card', async () => {
    const empty = { schemaVersion: 1, accountExternalId: '42', dealExternalId: '123', startedAt: time, finishedAt: time,
      readComplete: true, reasonCodes: [], chats: [], inventory: { initial: [capture(null, 204)], confirmation: [capture(null, 204)],
        relatedInitial: capture(null, 204), relatedConfirmation: capture(null, 204) } };
    (readEmptyCrmChatHistory as jest.Mock).mockResolvedValue(empty);
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(readEmptyCrmChatHistory).toHaveBeenCalledWith({}, { origin: 'https://test.amocrm.ru', connectionId: 'connection-1',
      accountExternalId: '42', dealExternalId: '123' });
    expect(browser.readCard).not.toHaveBeenCalled(); expect(createCrmControlChatNative).not.toHaveBeenCalled();
    expect(result.value).toMatchObject({ communicationsComplete: false, chatCoverage: { readComplete: true, chats: 0, messages: 0, boundMessages: 0, reasonCodes: [] } });
    expect((await service.readManifest(result.value.manifest!, '123')).chatHistory).toEqual(empty);
    expect(result.value.documents[0].artifact).toBeDefined();
  });

  it('archives native captures and grounded normalization privately, returning only coverage and a content-addressed reference', async () => {
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(browser.readCard).toHaveBeenCalledTimes(1);
    expect(createCrmControlChatNative).toHaveBeenCalledWith({ fixturePage: true }, { origin: 'https://test.amocrm.ru',
      connectionId: 'connection-1', accountExternalId: '42', dealExternalId: '123' });
    expect(native.readNativeExternalTargets).toHaveBeenCalledWith(['chat-1']);
    expect(result.value.chatCoverage).toEqual({ readComplete: true, chats: 1, messages: 1, boundMessages: 1, reasonCodes: [] });
    const privateManifest = await service.readManifest(result.value.manifest!, '123');
    expect(privateManifest.chatHistory?.chats[0].messages[0].capture.value).toEqual(chatMessages[0]);
    expect(privateManifest.chatAccount).toEqual(native.accountMetadata);
    expect(privateManifest.chatMessages?.[0]).toMatchObject({ text: chatMessages[0].message.text, actorKind: 'external', direction: 'incoming',
      eligibleAsSemanticSource: true, binding: { kind: 'exact_lead', leadExternalId: '123' }, connectionId: 'connection-1' });
    const reference = result.value.manifest!, bytes = await readFile(path.join(folder, reference.storageKey));
    expect(reference).toEqual({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      storageKey: `${createHash('sha256').update(bytes).digest('hex')}.browser-history.json` });
    const publicJson = JSON.stringify(result.value);
    for (const privateText of ['PRIVATE SYNTHETIC', 'PRIVATE TEST', 'customer-1', 'staff-1', 'account-chat-42', 'private-signed-url']) {
      expect(publicJson).not.toContain(privateText);
    }
    expect(result.value.communicationsComplete).toBe(false);
  });

  it.each([{ connectionId: undefined }, { accountExternalId: undefined }])('does not read chats without a complete expected scope %o', async patch => {
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob(patch)));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(readEmptyCrmChatHistory).not.toHaveBeenCalled(); expect(browser.readCard).not.toHaveBeenCalled();
    expect(result.value.chatCoverage).toMatchObject({ readComplete: false, reasonCodes: ['CHAT_ACCOUNT_UNVERIFIED'] });
    expect(result.value.documents[0].artifact).toBeDefined();
  });

  it('does not read any document or chat from a browser account different from the requested connection', async () => {
    accountExternalId = '99';
    await expect(service.withBatch(batch => batch.collectCurrent(chatJob()))).rejects.toThrow('HISTORY_ACCOUNT_CONFLICT');
    expect(createCrmBrowserHistoryReader).not.toHaveBeenCalled(); expect(historyCollect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled(); expect(downloadMailAttachment).not.toHaveBeenCalled();
    expect(readEmptyCrmChatHistory).not.toHaveBeenCalled(); expect(browser.readCard).not.toHaveBeenCalled();
  });

  it('does not read under an expected account when the bootstrap cannot verify that account', async () => {
    accountExternalId = null;
    await expect(service.withBatch(batch => batch.collectCurrent(chatJob()))).rejects.toThrow('HISTORY_ACCOUNT_CONFLICT');
    expect(createCrmBrowserHistoryReader).not.toHaveBeenCalled(); expect(downloadMailAttachment).not.toHaveBeenCalled();
    expect(readEmptyCrmChatHistory).not.toHaveBeenCalled(); expect(browser.readCard).not.toHaveBeenCalled();
  });

  it('falls back from a non-auth fast probe error to native collection while preserving document evidence', async () => {
    (readEmptyCrmChatHistory as jest.Mock).mockRejectedValue(new Error('Private upstream response'));
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(browser.readCard).toHaveBeenCalledTimes(1); expect(result.value.chatCoverage?.readComplete).toBe(true);
    expect(result.value.documents[0].artifact).toBeDefined(); expect(JSON.stringify(result.value)).not.toContain('Private upstream');
  });

  it('propagates fast-probe401 for a complete source-reader retry instead of declaring empty chats', async () => {
    (readEmptyCrmChatHistory as jest.Mock).mockRejectedValue(new CrmSourceAuthExpiredError());
    await expect(service.withBatch(batch => batch.collectCurrent(chatJob()))).rejects.toBeInstanceOf(CrmSourceAuthExpiredError);
    expect(browser.readCard).not.toHaveBeenCalled();
  });

  it.each(['AUTH_REQUIRED', 'CAPTURE_FAILED', 'SESSION_BUSY'])('preserves collected mail documents when native reading ends with %s', async errorCode => {
    browser.readCard.mockResolvedValueOnce({ ok: false, errorCode, retryable: true, message: 'Safe error message' });
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.documents[0].artifact).toBeDefined();
    expect(result.value.chatCoverage).toMatchObject({ readComplete: false, chats: 0, messages: 0, reasonCodes: [errorCode] });
    expect(result.value.reasonCodes).toContain(errorCode);
    const stored = await service.readManifest(result.value.manifest!, '123');
    expect(stored.history.threads[0].messages[0].content).toBe('PRIVATE TEST MESSAGE BODY');
    expect(stored.chatHistory).toBeUndefined();
  });

  it('archives partial native history honestly when message counts change during the read', async () => {
    native.transport.readCount.mockResolvedValueOnce(1).mockResolvedValue(2);
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.chatCoverage).toMatchObject({ readComplete: false, chats: 1, reasonCodes: ['CHAT_COUNT_CHANGED_OR_INCOMPLETE'] });
    expect(result.value.documents[0].artifact).toBeDefined(); expect(result.value.communicationsComplete).toBe(false);
    const stored = await service.readManifest(result.value.manifest!, '123');
    expect(stored.chatHistory?.chats[0].reasonCodes).toContain('CHAT_COUNT_CHANGED_OR_INCOMPLETE');
  });

  it('keeps an unverified actor in private history without using the text as a customer agreement', async () => {
    native.readNativeExternalTargets.mockResolvedValue([]);
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.chatCoverage).toMatchObject({ readComplete: true, messages: 1, boundMessages: 1 });
    expect(result.value.chatCoverage?.reasonCodes).toContain('CHAT_EXTERNAL_CONTACT_UNVERIFIED');
    expect(result.value.documents[0].artifact).toBeDefined();
    const stored = await service.readManifest(result.value.manifest!, '123');
    expect(stored.chatMessages?.[0]).toMatchObject({ actorKind: 'unknown', direction: 'unverified', eligibleAsSemanticSource: false });
    expect(stored.chatHistory?.chats[0].messages[0].capture.value).toEqual(chatMessages[0]);
  });

  it('preserves captured chat history and mail when actor lookup fails without exposing its error details', async () => {
    native.readNativeExternalTargets.mockRejectedValue(new Error('private-cookie=secret; customer chat body'));
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.documents[0].artifact).toBeDefined();
    expect(result.value.chatCoverage).toMatchObject({ readComplete: true, chats: 1, messages: 1, boundMessages: 1 });
    expect(result.value.chatCoverage?.reasonCodes).toContain('CHAT_ACTORS_UNAVAILABLE');
    const stored = await service.readManifest(result.value.manifest!, '123');
    expect(stored.chatHistory?.chats[0].messages[0].capture.value).toEqual(chatMessages[0]);
    expect(stored.chatMessages?.[0]).toMatchObject({ actorKind: 'unknown', eligibleAsSemanticSource: false });
    expect(JSON.stringify(result.value)).not.toContain('secret'); expect(JSON.stringify(stored)).not.toContain('secret');
  });

  it('propagates actor401 into the provider retry path rather than preserving it as an actor-only error', async () => {
    native.readNativeExternalTargets.mockRejectedValue(new CrmSourceAuthExpiredError());
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    // The fixture provider models a terminal AUTH_REQUIRED response; the real provider retries the complete card once.
    expect(result.value.documents[0].artifact).toBeDefined();
    expect(result.value.chatCoverage).toMatchObject({ readComplete: false, reasonCodes: ['AUTH_REQUIRED'] });
    expect(result.value.chatCoverage?.reasonCodes).not.toContain('CHAT_ACTORS_UNAVAILABLE');
    expect((await service.readManifest(result.value.manifest!, '123')).chatHistory).toBeUndefined();
  });

  it('does not normalize messages explicitly bound to a different deal', async () => {
    native.transport.readTalk.mockImplementation(async () => capture({ ...chatTalk(), entity_id: 456,
      _embedded: { contacts: [{ id: 55 }], leads: [{ id: 456 }], customers: [] } }));
    const result = await service.withBatch(batch => batch.collectCurrent(chatJob()));
    if (!result.ok) throw Error('Unexpected fixture failure');
    expect(result.value.chatCoverage).toMatchObject({ readComplete: true, messages: 1, boundMessages: 0 });
    const stored = await service.readManifest(result.value.manifest!, '123');
    expect(stored.chatHistory?.chats[0].messages[0].binding.status).toBe('OTHER_DEAL');
    expect(stored.chatMessages).toEqual([]);
  });
});
