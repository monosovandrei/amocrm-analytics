import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, Browser } from 'playwright-core';

export interface CrmControlCaptureJob {
  dealExternalId: string;
  sourceUrl: string;
  observationId: string;
  dealTitle?: string;
}

export interface CrmControlCaptureResult {
  status: 'READY' | 'ERROR' | 'DISABLED';
  storageKey?: string;
  mimeType?: string;
  sha256?: string;
  capturedAt?: Date;
  message?: string;
}

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Only the account origin and the observed lead ID may select a capture target. */
export function validateCrmCaptureUrl(sourceUrl: string, dealExternalId: string, origin: string): URL {
  let url: URL;
  let account: URL;
  try {
    url = new URL(sourceUrl);
    account = new URL(origin);
  } catch {
    throw new Error('Некорректный адрес amoCRM для снимка.');
  }
  if (!/^\d+$/.test(dealExternalId)
    || account.protocol !== 'https:'
    || !/^[a-z0-9][a-z0-9-]*\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i.test(account.hostname)
    || account.username || account.password || account.port || account.search || account.hash
    || account.pathname !== '/'
    || url.origin !== account.origin || url.username || url.password || url.search || url.hash
    || ![ `/leads/detail/${dealExternalId}`, `/leads/detail/${dealExternalId}/` ].includes(url.pathname)) {
    throw new Error('Адрес снимка не соответствует настроенному аккаунту и сделке.');
  }
  return url;
}

@Injectable()
export class CrmControlEvidenceService {
  capabilities(): { screenshots: boolean; message?: string } {
    const state = process.env.CRM_CONTROL_BROWSER_STATE_FILE;
    const executable = process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE;
    const origin = process.env.CRM_CONTROL_AMO_ORIGIN;
    if (!state || !executable || !origin) {
      return {
        screenshots: false,
        message: 'Скриншоты не подключены: настройте отдельную сессию amoCRM для сборщика. Архивные данные сохраняются независимо.',
      };
    }
    try {
      validateCrmCaptureUrl(`${new URL(origin).origin}/leads/detail/1`, '1', origin);
    } catch {
      return { screenshots: false, message: 'Адрес аккаунта для сборщика скриншотов задан неверно.' };
    }
    if (!existsSync(state) || !existsSync(executable)) {
      return { screenshots: false, message: 'Сборщику недоступны браузер или файл сессии amoCRM.' };
    }
    return { screenshots: true, message: 'Сборщик настроен. Доступ к карточке проверяется при каждом снимке.' };
  }

  async capture(job: CrmControlCaptureJob): Promise<CrmControlCaptureResult> {
    const capability = this.capabilities();
    if (!capability.screenshots) return { status: 'DISABLED', message: capability.message };
    let browser: Browser | undefined;
    try {
      const url = validateCrmCaptureUrl(job.sourceUrl, job.dealExternalId, process.env.CRM_CONTROL_AMO_ORIGIN!);
      browser = await chromium.launch({
        executablePath: process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE!,
        headless: true,
        chromiumSandbox: true,
        timeout: 25_000,
      });
      const context = await browser.newContext({
        storageState: process.env.CRM_CONTROL_BROWSER_STATE_FILE!,
        viewport: { width: 1600, height: 1200 },
        deviceScaleFactor: 1,
        locale: 'ru-RU',
        acceptDownloads: false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      // Never follow a document redirect to another account, login provider or arbitrary URL.
      await page.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            validateCrmCaptureUrl(request.url(), job.dealExternalId, process.env.CRM_CONTROL_AMO_ORIGIN!);
          } catch {
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      });
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 35_000 });
      if (!response || response.status() >= 400) throw new Error('CRM_CAPTURE_PAGE_UNAVAILABLE');
      validateCrmCaptureUrl(page.url(), job.dealExternalId, process.env.CRM_CONTROL_AMO_ORIGIN!);

      // These selectors were verified in the actual amoCRM lead card on 2026-09-18.
      const title = page.locator('textarea[name="lead[NAME]"]');
      await title.waitFor({ state: 'visible' });
      const placeholder = await title.getAttribute('placeholder');
      if (placeholder !== `Сделка #${job.dealExternalId}` || !(await title.inputValue()).trim()) {
        throw new Error('CRM_CAPTURE_WRONG_CARD');
      }
      await page.locator('#card_holder .js-card-feed').waitFor({ state: 'visible' });
      await page.locator('#card_holder .js-notes').waitFor({ state: 'attached' });
      await page.locator('#lead_card_budget').waitFor({ state: 'visible' });
      if (await page.locator('input[type="password"]').isVisible()) throw new Error('CRM_CAPTURE_SIGN_IN');
      const currentTitle = await title.inputValue();
      const capturedAt = new Date();
      const buffer = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 15_000 });
      if (buffer.length > MAX_EVIDENCE_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('CRM_CAPTURE_INVALID_IMAGE');
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const storageKey = `${sha256}.png`;
      const directory = this.directory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Content-addressed, append-only evidence. An existing identical image is reused.
      try {
        await writeFile(path.join(directory, storageKey), buffer, { flag: 'wx', mode: 0o600 });
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await this.read(storageKey);
        if (!existing.buffer.equals(buffer)) throw new Error('CRM_CAPTURE_INVALID_IMAGE');
      }
      return {
        status: 'READY', storageKey, mimeType: 'image/png', sha256, capturedAt,
        message: 'Снимок видимой области amoCRM на момент съёмки. Скрытые и свёрнутые записи в кадр не входят; исходные данные проверки сохранены отдельно.'
          + (job.dealTitle && currentTitle !== job.dealTitle ? ' Название сделки изменилось после проверки.' : ''),
      };
    } catch (error: any) {
      // Browser errors can contain URLs, filesystem paths and fragments of pages. Do not expose them.
      const message = error?.message === 'CRM_CAPTURE_WRONG_CARD'
        ? 'Открылась другая карточка сделки. Снимок не сохранён.'
        : error?.message === 'CRM_CAPTURE_INVALID_IMAGE'
          ? 'Файл снимка не прошёл проверку целостности.'
          : 'Не удалось получить доступную карточку amoCRM. Проверьте вход сборщика и загрузку сделки; снимок страницы входа не сохраняется.';
      return { status: 'ERROR', message };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async read(storageKey: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (!/^[a-f0-9]{64}\.png$/.test(storageKey)) throw new NotFoundException('Подтверждение не найдено');
    try {
      const filePath = path.join(this.directory(), storageKey);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) throw new Error('Invalid file');
      const buffer = await readFile(filePath);
      if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)
        || `${createHash('sha256').update(buffer).digest('hex')}.png` !== storageKey) throw new Error('Invalid file');
      return { buffer, contentType: 'image/png' };
    } catch {
      throw new NotFoundException('Подтверждение недоступно или повреждено');
    }
  }

  private directory(): string {
    return path.resolve(process.env.CRM_CONTROL_EVIDENCE_DIR || 'outputs/crm-control-evidence');
  }
}
