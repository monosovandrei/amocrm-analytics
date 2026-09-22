import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveMailAttachment, detectMailArtifactType, downloadMailAttachment, validateMailAttachmentDownload } from './crm-control-browser-files';

const url = 'https://amoattachonsr.amocrm.com/attachment/download?id=91&token=private&ts=123&k=signed';
const pdf = Buffer.from('%PDF-1.4\nTest only, not a client document.');

describe('private mail attachment archive', () => {
  it('requires exact observed host, route, signed parameters and attachment identity', () => {
    expect(validateMailAttachmentDownload(url, '91')).toBe(url);
    for (const value of [url.replace('id=91', 'id=92'), url.replace('https:', 'http:'), url.replace('amoattachonsr.amocrm.com', 'evil.test'),
      url.replace('/attachment/download', '/unrelated'), url + '&id=91', url + '#secret', url.replace('&k=signed', '')]) {
      expect(() => validateMailAttachmentDownload(value, '91')).toThrow();
    }
  });

  it('downloads without session or OAuth headers and computes a binary hash with verified MIME', async () => {
    const request = jest.fn().mockResolvedValue(new Response(pdf, { headers: { 'content-type': 'application/octet-stream' } }));
    const file = await downloadMailAttachment(url, '91', { maxBytes: 1024, signal: AbortSignal.timeout(1000), fetch: request as any });
    expect(file).toMatchObject({ size: pdf.length, contentType: 'application/pdf', sha256: createHash('sha256').update(pdf).digest('hex') });
    expect(request.mock.calls[0][1]).not.toHaveProperty('headers');
    expect(request.mock.calls[0][1].redirect).toBe('manual');
  });

  it('rejects a redirect changing attachment identity before requesting the foreign file', async () => {
    const request = jest.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: url.replace('id=91', 'id=92') } }));
    await expect(downloadMailAttachment(url, '91', { maxBytes: 1024, signal: AbortSignal.timeout(1000), fetch: request as any })).rejects.toThrow('MAIL_DOWNLOAD_IDENTITY_INVALID');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('enforces declared and streamed size limits and does not archive HTML login/error pages', async () => {
    for (const response of [new Response(pdf, { headers: { 'content-length': '9999' } }), new Response(pdf)]) {
      await expect(downloadMailAttachment(url, '91', { maxBytes: 10, signal: AbortSignal.timeout(1000), fetch: jest.fn().mockResolvedValue(response) as any })).rejects.toThrow('MAIL_ATTACHMENT_TOO_LARGE');
    }
    expect(() => detectMailArtifactType(Buffer.from('<html>Login</html>'), 'text/html')).toThrow('MAIL_ATTACHMENT_TYPE_UNSUPPORTED');
  });

  it('archives and reuses a hash path, then refuses a corrupted existing artifact', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'crm-browser-files-'));
    try {
      const file = { bytes: pdf, size: pdf.length, contentType: 'application/pdf', sha256: createHash('sha256').update(pdf).digest('hex') };
      const artifact = await archiveMailAttachment(folder, file);
      expect(artifact.storageKey).toBe(`${file.sha256}.bin`);
      expect(await readFile(path.join(folder, artifact.storageKey))).toEqual(pdf);
      await expect(archiveMailAttachment(folder, file)).resolves.toMatchObject({ sha256: file.sha256 });
      await writeFile(path.join(folder, artifact.storageKey), 'corrupted');
      await expect(archiveMailAttachment(folder, file)).rejects.toThrow('MAIL_ARCHIVE_INVALID');
    } finally {
      const absolute = path.resolve(folder);
      if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith('crm-browser-files-')) await rm(absolute, { recursive: true, force: true });
    }
  });
});
