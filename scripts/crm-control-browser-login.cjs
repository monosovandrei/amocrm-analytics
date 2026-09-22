// Run interactively on the capture host. Credentials are entered only in the amoCRM page.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.resolve(__dirname, '../apps/api/package.json'));
const { chromium } = apiRequire('playwright-core');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function runtime() {
  const directory = process.env.CRM_CONTROL_LOGIN_USE_SOURCE === '1' ? 'src' : 'dist';
  if (directory === 'src') apiRequire('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../apps/api/tsconfig.json') });
  return {
    ...apiRequire(`./${directory}/crm-control/crm-control-browser-session`),
    ...apiRequire(`./${directory}/crm-control/crm-control-browser-auth`), chromium,
  };
}

async function main(dependencies = runtime(), env = process.env, args = process.argv.slice(2)) {
  const origin = new URL(env.CRM_CONTROL_AMO_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
    || origin.pathname !== '/' || origin.search || origin.hash
    || !/^[a-z0-9][a-z0-9-]*\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i.test(origin.hostname)) {
    throw new Error('Укажите CRM_CONTROL_AMO_ORIGIN — HTTPS-адрес вашего аккаунта amoCRM.');
  }
  const stateFile = env.CRM_CONTROL_BROWSER_STATE_FILE;
  const executablePath = env.CRM_CONTROL_CHROMIUM_EXECUTABLE;
  if (!stateFile || !executablePath) throw new Error('Задайте путь к файлу сессии и исполняемому файлу браузера.');
  const statePath = path.resolve(stateFile);
  const project = path.resolve(__dirname, '..');
  const relativeState = path.relative(project, statePath);
  if (!relativeState.startsWith('..') && !path.isAbsolute(relativeState)
    && !relativeState.startsWith(`outputs${path.sep}`)) {
    throw new Error('Храните сессию вне репозитория или в исключённой из Git папке outputs.');
  }
  if (args.length && !(args.length === 1 && args[0] === '--mark-transferred')) throw new Error('Неизвестная команда.');
  const transferMarker = `${statePath}.transferred`;
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lease = await dependencies.acquireCrmBrowserSessionLease(statePath);
  let browser, context, page, access, expectedRawHash, checkpointSaved = false, refreshed = false, saved = false;
  try {
    const previous = await lease.readState();
    expectedRawHash = previous.rawHash;
    if (args[0] === '--mark-transferred') {
      if (!previous.state || !previous.rawHash) throw new Error('Нет сохранённой сессии для передачи.');
      const validation = JSON.parse(await fs.readFile(`${statePath}.refresh-verified`, 'utf8'));
      if (validation.rawHash !== previous.rawHash || validation.refreshVerified !== true) throw new Error('Обновление этой сессии ещё не проверено.');
      await fs.writeFile(transferMarker, JSON.stringify({ version: 1, transferredAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
      console.log('Локальное использование сессии заблокировано. Передайте серверу только файл сессии, без файла .transferred.');
      return;
    }
    const dealId = env.CRM_CONTROL_SESSION_PROBE_LEAD_ID;
    if (!/^[1-9]\d{0,19}$/.test(dealId || '')) throw new Error('Задайте CRM_CONTROL_SESSION_PROBE_LEAD_ID — доступную сборщику сделку для проверки входа.');
    // A transferred old state is never imported. Only a completely new interactive login can replace it.
    browser = await dependencies.chromium.launch({ executablePath, headless: false, chromiumSandbox: true, args: ['--start-maximized'] });
    context = await browser.newContext({ locale: 'ru-RU' });
    page = await context.newPage();
    await page.goto(origin.origin, { waitUntil: 'domcontentloaded' });
    console.log('Войдите в amoCRM в отдельном окне «amoCRM: Авторизация». После входа сессия сохранится автоматически.');
    await page.waitForURL(url => url.origin === origin.origin && /^\/(dashboard|leads|todo|contacts|settings)\//.test(url.pathname), { timeout: 30 * 60_000 });
    await page.locator('#nav_menu').waitFor({ state: 'visible', timeout: 30_000 });
    const current = new URL(page.url());
    if (current.origin !== origin.origin || !/^\/(dashboard|leads|todo|contacts|settings)\//.test(current.pathname)) {
      throw new Error('Вход в нужный аккаунт не подтверждён. Сессия не сохранена.');
    }
    if (!await page.locator('#nav_menu').isVisible() || await page.locator('input[type="password"]:visible').count()) {
      throw new Error('Рабочий экран amoCRM не найден. Сессия не сохранена.');
    }
    access = dependencies.observeCrmBrowserAccess(page, origin.origin, dealId);
    const probeUrl = `${origin.origin}/leads/detail/${dealId}`;
    const navigate = async () => {
      const response = await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
      if (!response || response.status() !== 200 || new URL(page.url()).origin !== origin.origin
        || !new RegExp(`^/leads/detail/${dealId}/?$`).test(new URL(page.url()).pathname)) throw new Error('Карточка проверки недоступна.');
    };
    await navigate();
    if (await access.read() !== 'READY') throw new Error('Доступ к ленте и почте не подтверждён.');
    // Retain the fresh working login before testing rotation. A failed test must not require another login.
    expectedRawHash = (await lease.saveState(await context.storageState(), expectedRawHash)).rawHash;
    checkpointSaved = true;
    // Exercise the real rotation now, before handing a supposedly unattended session to the worker.
    if (await dependencies.refreshCrmBrowserAccess(page) !== 'READY') {
      const error = new Error('Штатное обновление входа не прошло.'); error.code = 'CRM_BROWSER_REFRESH_NOT_VERIFIED'; throw error;
    }
    refreshed = true;
    access.reset();
    await navigate();
    if (await access.read() !== 'READY') throw new Error('Доступ к ленте и почте не подтверждён.');
    // Stop page activity first so a late automatic rotation cannot be lost after the last state snapshot.
    await page.close(); page = undefined;
    access.dispose(); access = undefined;
    expectedRawHash = (await lease.saveState(await context.storageState(), expectedRawHash)).rawHash;
    saved = true;
    const validationPath = `${statePath}.refresh-verified`, temporaryValidation = `${validationPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryValidation, JSON.stringify({ refreshVerified: true, rawHash: expectedRawHash, checkedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporaryValidation, validationPath);
    } finally { await fs.unlink(temporaryValidation).catch(() => undefined); }
    await fs.unlink(transferMarker).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log('Вход, лента, почта и обновление сессии проверены. Сессия сохранена. Перед передачей серверу выполните --mark-transferred.');
  } finally {
    try {
      await page?.close().catch(() => undefined);
      if (!saved && checkpointSaved && (refreshed || access?.tokensRotated)) {
        await lease.saveState(await context.storageState(), expectedRawHash);
      }
    } finally {
      access?.dispose();
      try { await browser?.close(); } finally { await lease.release(); }
    }
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => {
  console.error(error?.code === 'CRM_BROWSER_REFRESH_NOT_VERIFIED'
    ? 'CRM_BROWSER_REFRESH_NOT_VERIFIED: рабочий вход сохранён, обновление не подтверждено. Нужна диагностика, повторный вход пока не требуется.'
    : error?.code === 'CRM_BROWSER_SESSION_BUSY'
    ? 'Сессия занята сборщиком. Завершите его пакет перед новым входом или передачей.'
    : 'Сессия не сохранена: проверка входа или его обновления не прошла. Проверьте настройки и доступ сборщика к пробной сделке.');
  process.exitCode = 1;
});
