import { OrganizerError } from '../core/errors.js';
import type { BrowserSession } from '../core/session.js';
import type { RouteRecorder } from '../core/routes.js';

const providers = {
  playwright: async (directory: string, routes: RouteRecorder, _env: NodeJS.ProcessEnv) => {
    const { StandaloneBackend } = await import('../browser/chromium/standalone.js');
    return new StandaloneBackend(directory, routes);
  },
  chrome: async (directory: string, routes: RouteRecorder, _env: NodeJS.ProcessEnv) => {
    const { ChromeBackend } = await import('../browser/chromium/chrome.js');
    return new ChromeBackend(directory, routes);
  },
  extension: async (directory: string, routes: RouteRecorder, env: NodeJS.ProcessEnv) => {
    const port = Number(env.CHATGPT_BRIDGE_PORT ?? 43127);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new OrganizerError('INVALID_BRIDGE_PORT', 'CHATGPT_BRIDGE_PORT 必须是 0 至 65535 的整数。');
    }
    const { ExtensionBackend } = await import('../browser/extension/backend.js');
    return new ExtensionBackend(directory, routes, { port });
  },
} satisfies Record<string, (directory: string, routes: RouteRecorder, env: NodeJS.ProcessEnv) => Promise<BrowserSession>>;

/** Select an implementation without starting a browser or connection service. */
export async function createBrowserSession(directory: string, routes: RouteRecorder, env = process.env): Promise<BrowserSession> {
  const kind = env.CHATGPT_TRANSPORT ?? 'playwright';
  if (!Object.hasOwn(providers, kind)) {
    throw new OrganizerError('INVALID_TRANSPORT', 'CHATGPT_TRANSPORT 仅支持 playwright、chrome 或 extension。');
  }
  return providers[kind as keyof typeof providers](directory, routes, env);
}
