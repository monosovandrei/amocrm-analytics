import type { BrowserContext, Page, Response } from 'playwright-core';

export type CrmBrowserAccess = 'READY' | 'AUTH_REQUIRED' | 'SOURCE_NOT_READY';

/** Metadata only. A still-present refresh token is not proof that the server will accept it. */
export async function crmBrowserNeedsRefresh(context: BrowserContext, origin: string, now = Date.now()): Promise<boolean> {
  const cookies = await context.cookies(origin);
  const token = cookies.find(cookie => cookie.name === 'access_token' && cookie.value);
  if (!token) return true;
  const declared = Number(cookies.find(cookie => cookie.name === 'access_token_expires_at')?.value);
  const expiry = token.expires > 0 ? token.expires : declared > 0 ? declared : 0;
  return !Number.isFinite(expiry) || expiry * 1000 <= now + 5 * 60_000;
}

/** The account's own browser client uses this implicit refresh request. No token enters an argument or result. */
export async function refreshCrmBrowserAccess(page: Page): Promise<CrmBrowserAccess> {
  try {
    const status = await page.evaluate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch('/oauth2/access_token', {
          method: 'POST', credentials: 'include', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
          body: 'grant_type=implicit',
        });
        // Set-Cookie is applied by the browser. Never expose the response body or cookies.
        return response.status;
      } finally { clearTimeout(timeout); }
    });
    return status === 200 ? 'READY' : [401, 403].includes(status) ? 'AUTH_REQUIRED' : 'SOURCE_NOT_READY';
  } catch { return 'SOURCE_NOT_READY'; }
}

/** Observe real source reads. A 200 HTML shell/menu alone must never mark the collector's login as healthy. */
export function observeCrmBrowserAccess(page: Page, origin: string, dealId: string) {
  let timeline: CrmBrowserAccess | null = null, mail: CrmBrowserAccess | null = null;
  let generation = 0, disposed = false, rotated = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const listener = (response: Response) => {
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (url.username || url.password || url.hash) return;
    if (url.origin === origin && url.pathname === '/oauth2/access_token'
      && response.request().method() === 'POST' && response.status() === 200) { rotated = true; return; }
    if (response.request().method() !== 'GET') return;
    const isTimeline = url.origin === origin && url.pathname.replace(/\/$/, '') === `/ajax/v3/leads/${dealId}/events_timeline`;
    const isMail = url.origin === 'https://amomail.amocrm.ru'
      && new RegExp(`^/api/v2/[1-9]\\d*/leads/${dealId}/compose$`).test(url.pathname);
    if (!isTimeline && !isMail) return;
    const observedGeneration = generation;
    const update = (value: CrmBrowserAccess) => {
      if (disposed || observedGeneration !== generation) return;
      if (isTimeline) timeline = value; else mail = value;
      notify();
    };
    if ([401, 403].includes(response.status())) { update('AUTH_REQUIRED'); return; }
    if (response.status() !== 200) { update('SOURCE_NOT_READY'); return; }
    void response.body().then(bytes => {
      if (bytes.length > 4 * 1024 * 1024) { update('SOURCE_NOT_READY'); return; }
      const value = JSON.parse(bytes.toString('utf8'));
      const valid = isTimeline ? Array.isArray(value?._embedded?.items) : Array.isArray(value);
      update(valid ? 'READY' : 'SOURCE_NOT_READY');
    }).catch(() => update('SOURCE_NOT_READY'));
  };
  page.on('response', listener);
  return {
    get tokensRotated() { return rotated; },
    reset() { generation++; timeline = null; mail = null; },
    async read(waitMs = 12_000): Promise<CrmBrowserAccess> {
      const current = (): CrmBrowserAccess | null => timeline === 'AUTH_REQUIRED' || mail === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED'
        : timeline === 'READY' && mail === 'READY' ? 'READY' : null;
      if (!current() && !disposed && waitMs > 0) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); listeners.delete(check); resolve(); };
        const check = () => { if (current() || disposed) finish(); };
        const timer = setTimeout(finish, Math.min(waitMs, 15_000));
        listeners.add(check); check();
      });
      return current() ?? 'SOURCE_NOT_READY';
    },
    dispose() { disposed = true; page.off('response', listener); notify(); },
  };
}
