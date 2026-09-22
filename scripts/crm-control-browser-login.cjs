// Run interactively on the capture host. Credentials are entered only in the amoCRM page.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.resolve(__dirname, '../apps/api/package.json'));
const { chromium } = apiRequire('playwright-core');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const origin = new URL(process.env.CRM_CONTROL_AMO_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
    || origin.pathname !== '/' || origin.search || origin.hash
    || !/^[a-z0-9][a-z0-9-]*\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i.test(origin.hostname)) {
    throw new Error('Укажите CRM_CONTROL_AMO_ORIGIN — HTTPS-адрес вашего аккаунта amoCRM.');
  }
  const stateFile = process.env.CRM_CONTROL_BROWSER_STATE_FILE;
  const executablePath = process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE;
  if (!stateFile || !executablePath) throw new Error('Задайте путь к файлу сессии и исполняемому файлу браузера.');
  const statePath = path.resolve(stateFile);
  const project = path.resolve(__dirname, '..');
  const relativeState = path.relative(project, statePath);
  if (!relativeState.startsWith('..') && !path.isAbsolute(relativeState)
    && !relativeState.startsWith(`outputs${path.sep}`)) {
    throw new Error('Храните сессию вне репозитория или в исключённой из Git папке outputs.');
  }
  const browser = await chromium.launch({ executablePath, headless: false, chromiumSandbox: true, args: ['--start-maximized'] });
  try {
    const context = await browser.newContext({ locale: 'ru-RU' });
    const page = await context.newPage();
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
    await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(statePath, JSON.stringify(await context.storageState()), { mode: 0o600 });
    console.log('Сессия сборщика сохранена. Не добавляйте этот файл в Git и не передавайте его менеджерам.');
  } finally {
    await browser.close();
  }
}
main().catch(() => {
  console.error('Не удалось настроить сессию. Проверьте CRM_CONTROL_AMO_ORIGIN, CRM_CONTROL_BROWSER_STATE_FILE, CRM_CONTROL_CHROMIUM_EXECUTABLE и выполните вход в аккаунт.');
  process.exitCode = 1;
});
