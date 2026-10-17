import { OrganizerError } from '../core/errors.js';
import type { BrowserSession } from '../core/session.js';
import type { RouteRecorder } from '../core/routes.js';

const providers = {
  playwright: async (directory: string, routes: RouteRecorder) => {
    const { StandaloneBackend } = await import('../browser/chromium/standalone.js');
    return new StandaloneBackend(directory, routes);
  },
  chrome: async (directory: string, routes: RouteRecorder) => {
    const { ChromeBackend } = await import('../browser/chromium/chrome.js');
    return new ChromeBackend(directory, routes);
  },
} satisfies Record<string, (directory: string, routes: RouteRecorder) => Promise<BrowserSession>>;

/** Select an implementation without starting a browser. */
export async function createBrowserSession(directory: string, routes: RouteRecorder, env = process.env): Promise<BrowserSession> {
  const kind = env.CHATGPT_TRANSPORT ?? 'playwright';
  if (!Object.hasOwn(providers, kind)) {
    throw new OrganizerError('INVALID_TRANSPORT', 'CHATGPT_TRANSPORT 仅支持 playwright 或 chrome。');
  }
  return providers[kind as keyof typeof providers](directory, routes);
}
