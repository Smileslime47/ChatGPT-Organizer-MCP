import { OrganizerError } from '../core/errors.js';
import { ORIGIN } from '../core/routes.js';
import { SessionBackend } from './base.js';
import type { BackendResponse, BrowserPage, PageRequest } from './types.js';
import type { BackendStatus } from '../core/session.js';

/** Drivers supply a page; authentication and API calls stay within that page. */
export abstract class PageSession extends SessionBackend {
  page: BrowserPage | null = null;

  async status(): Promise<BackendStatus> {
    if (!this.page || this.page.isClosed()) return { browser_open: false, logged_in: false };
    if (new URL(this.page.url()).origin !== ORIGIN) return { browser_open: true, logged_in: false, action: '请在专用窗口完成 ChatGPT 登录。' };
    try {
      const loggedIn = await this.page.evaluate(async () => {
        if (location.origin !== 'https://chatgpt.com') return false;
        const response = await fetch('/api/auth/session', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (response.status === 401) return false;
        if (!response.ok) throw new Error('Session check unavailable');
        const session: unknown = await response.json();
        return session !== null && typeof session === 'object' && 'accessToken' in session
          && typeof session.accessToken === 'string' && session.accessToken.length > 0;
      });
      return { browser_open: true, logged_in: loggedIn === true, action: loggedIn === true ? undefined : '请在专用窗口完成 ChatGPT 登录。' };
    } catch { return { browser_open: true, logged_in: false, login_check_failed: true, action: '暂时无法验证登录，请检查网络或网页验证提示后重试。' }; }
  }

  protected assertRequestReady(): void {
    if (!this.page || this.page.isClosed()) throw new OrganizerError('LOGIN_REQUIRED', '先调用 chatgpt_open_browser，然后在专用窗口登录。');
    if (new URL(this.page.url()).origin !== ORIGIN) throw new OrganizerError('LOGIN_REQUIRED', '请在专用窗口完成 ChatGPT 登录并返回 chatgpt.com。');
  }

  protected async evaluateRequest(args: PageRequest): Promise<unknown> {
    if (!this.page) throw new OrganizerError('LOGIN_REQUIRED', '先调用 chatgpt_open_browser，然后在专用窗口登录。');
    return this.page.evaluate(async ({ method, path, body, account }): Promise<BackendResponse> => {
      // This function executes in the page. Keep validation self-contained and
      // credentials inside the browser; no imported helpers are available here.
      try {
        if (location.origin !== 'https://chatgpt.com') return { status: 401 };
        const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!sessionResponse.ok) return { status: 401 };
        const session: unknown = await sessionResponse.json();
        if (!session || typeof session !== 'object' || !('accessToken' in session)
          || typeof session.accessToken !== 'string' || !session.accessToken) return { status: 401 };
        const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (account) headers['chatgpt-account-id'] = account;
        const response = await fetch(path, {
          method, headers, credentials: 'include', redirect: 'error',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) return { status: response.status, retry_after: response.headers.get('retry-after') };
        if (response.status === 204) return { status: 204, data: null };
        if (!response.headers.get('content-type')?.includes('application/json')) return { status: 502 };
        const text = await response.text();
        if (text.length > 8_000_000) return { status: 413 };
        const data: unknown = JSON.parse(text);
        return { status: response.status, data };
      } catch { return { status: 0 }; }
    }, args);
  }
}
