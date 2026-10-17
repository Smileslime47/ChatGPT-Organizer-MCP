import type { PageCommand, PageResult, ValidationDetail } from './types.js';

// Executed in the extension's isolated world in an explicitly selected ChatGPT
// tab. This function must remain self-contained for chrome.scripting.
export async function pageTask(input: PageCommand | string): Promise<PageResult> {
  // Pass through Chrome scripting as one string so required JSON null fields
  // cannot be omitted by the extension API's argument conversion.
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  let command: unknown = input;
  try {
    if (typeof command === 'string') command = JSON.parse(command) as unknown;
    if (!isRecord(command) || (command.type !== 'status' && command.type !== 'request')) return { status: 403 };
    if (location.origin !== 'https://chatgpt.com') return { status: 403 };
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!sessionResponse.ok) return command.type === 'status' ? { browser_open: true, logged_in: false } : { status: 401 };
    const session: unknown = await sessionResponse.json();
    const accessToken = isRecord(session) && typeof session.accessToken === 'string' ? session.accessToken : '';
    const loggedIn = accessToken.length > 0;
    if (command.type === 'status') return { browser_open: true, logged_in: loggedIn };
    if (!loggedIn) return { status: 401 };
    if (!isRecord(command.request)) return { status: 403 };
    const { path, method = 'GET', body, account } = command.request;
    if (typeof path !== 'string' || typeof method !== 'string' || (account !== undefined && typeof account !== 'string')) return { status: 403 };
    const url = new URL(path, location.origin);
    if (!path.startsWith('/backend-api/') || url.origin !== location.origin || !url.pathname.startsWith('/backend-api/') || !['GET', 'POST', 'PATCH', 'PUT'].includes(method)) return { status: 403 };
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (account) headers['chatgpt-account-id'] = account;
    const response = await fetch(url, { method, headers, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      let validation: ValidationDetail[] | undefined;
      if (response.status === 422 && response.headers.get('content-type')?.includes('application/json')) {
        try {
          const error: unknown = await response.json();
          if (isRecord(error) && Array.isArray(error.detail)) validation = error.detail.slice(0, 20).map((item: unknown) => ({
            location: isRecord(item) && Array.isArray(item.loc) ? item.loc.filter((part: unknown): part is string | number => typeof part === 'string' || typeof part === 'number').slice(0, 10) : [],
            type: isRecord(item) && typeof item.type === 'string' ? item.type.slice(0, 100) : 'unknown',
          }));
        } catch { /* Do not return error response bodies, messages or input values. */ }
      }
      return { status: response.status, retry_after: response.headers.get('retry-after'), validation };
    }
    if (response.status === 204) return { status: 204, data: null };
    if (!response.headers.get('content-type')?.includes('application/json')) return { status: 502 };
    const text = await response.text();
    if (text.length > 8_000_000) return { status: 413 };
    return { status: response.status, data: JSON.parse(text) as unknown };
  } catch { return isRecord(command) && command.type === 'status' ? { browser_open: true, logged_in: false } : { status: 0 }; }
}
