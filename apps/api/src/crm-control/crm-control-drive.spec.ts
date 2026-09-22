import { CrmControlDriveReader, downloadProposalFile, readProposalFileField, validatedDriveOrigin } from './crm-control-drive';

const fileUuid = '11111111-1111-4111-a111-111111111111';
const versionUuid = '22222222-2222-4222-a222-222222222222';
const newerUuid = '33333333-3333-4333-a333-333333333333';
const reference = { fileUuid, versionUuid, name: 'КП.pdf', size: null };
const url = `https://drive-b.amocrm.ru/download/account/${fileUuid}/${versionUuid}/offer.pdf`;

describe('proposal field and exact Drive version', () => {
  test('uses configured field and keeps every attachment', () => {
    const field = (id: number, version: string) => ({ field_id: id, values: [{ value: { file_uuid: fileUuid, version_uuid: version } }] });
    expect(readProposalFileField([field(11, newerUuid), field(22, versionUuid)], '22')).toMatchObject({ complete: true, files: [{ fileUuid, versionUuid }] });
    expect(readProposalFileField([], '22')).toEqual({ complete: true, files: [], problem: null });
    expect(readProposalFileField(null, '22').complete).toBe(false);
    expect(readProposalFileField([field(22, versionUuid), field(22, newerUuid)], '22').complete).toBe(false);
    expect(readProposalFileField([{ field_id: 22, values: [{ value: { file_uuid: fileUuid } }] }], '22').complete).toBe(false);
  });

  test.each(['http://drive-b.amocrm.ru', 'https://drive-b.amocrm.ru.evil.test', 'https://localhost', 'https://drive-b.amocrm.ru/path', 'https://user@drive-b.amocrm.ru', 'https://drive-b.amocrm.ru?x=1'])('rejects unsafe Drive origin %s', origin => {
    expect(() => validatedDriveOrigin(origin)).toThrow();
  });

  test('never substitutes latest version for the version stored in КП', async () => {
    const getDrive = jest.fn().mockResolvedValueOnce({ uuid: fileUuid, version_uuid: newerUuid })
      .mockResolvedValueOnce({ _embedded: { versions: [{ uuid: newerUuid, file_uuid: fileUuid }] }, _links: { next: { href: 'ignored-untrusted-link' } } })
      .mockResolvedValueOnce({ _embedded: { versions: [{ uuid: versionUuid, file_uuid: fileUuid, size: 100, _links: { download: { href: url } } }] } });
    const result = await new CrmControlDriveReader({ getDrive }, 'https://drive-b.amocrm.ru').resolve(reference);
    expect(result.versionUuid).toBe(versionUuid);
    expect(result.downloadUrl).toBe(url);
    expect(getDrive.mock.calls[2][1]).toBe(`/v1.0/files/${fileUuid}/versions?limit=100&page=2`);
  });

  test('rejects current-version links when requested version differs', async () => {
    const getDrive = jest.fn().mockResolvedValue({ uuid: fileUuid, version_uuid: versionUuid, _links: { download_version: { href: url.replace(versionUuid, newerUuid) } } });
    await expect(new CrmControlDriveReader({ getDrive }, 'https://drive-b.amocrm.ru').resolve(reference)).rejects.toThrow('VERSION_MISMATCH');
  });

  test('missing exact version remains an error', async () => {
    const getDrive = jest.fn().mockResolvedValueOnce({ uuid: fileUuid, version_uuid: newerUuid }).mockResolvedValueOnce({ _embedded: { versions: [] } });
    await expect(new CrmControlDriveReader({ getDrive }, 'https://drive-b.amocrm.ru').resolve(reference)).rejects.toThrow('VERSION_NOT_FOUND');
  });
});

describe('proposal download boundaries', () => {
  test('hashes actual bytes and does not send OAuth to signed links', async () => {
    const request = jest.fn().mockResolvedValue(new Response('test document'));
    const result = await downloadProposalFile(url, { fetch: request });
    expect(result.bytes.toString()).toBe('test document');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(request.mock.calls[0][1]).not.toHaveProperty('headers');
  });

  test('rejects redirects to arbitrary hosts before following them', async () => {
    const request = jest.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    await expect(downloadProposalFile(url, { fetch: request })).rejects.toThrow('INVALID_FILE_DOWNLOAD_ORIGIN');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('limits streamed size even without content-length', async () => {
    const request = jest.fn().mockResolvedValue(new Response('too large'));
    await expect(downloadProposalFile(url, { fetch: request, maxBytes: 3 })).rejects.toThrow('FILE_TOO_LARGE');
  });

  test('rejects a redirect to a different version even on the same trusted host', async () => {
    const request = jest.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: url.replace(versionUuid, newerUuid) } }));
    await expect(downloadProposalFile(url, { fetch: request })).rejects.toThrow('FILE_REDIRECT_IDENTITY_CHANGED');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not mistake expired links for documents', async () => {
    const request = jest.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(downloadProposalFile(url, { fetch: request })).rejects.toThrow('FILE_DOWNLOAD_HTTP_403');
  });
});
