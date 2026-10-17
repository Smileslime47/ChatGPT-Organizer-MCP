import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RouteStore } from '../storage/routes.js';
import { createBrowserSession } from './session-factory.js';
import type { BrowserSession } from '../core/session.js';
import { Organizer } from '../core/organizer.js';
import { createServer } from './server.js';
import { errorResult } from '../core/errors.js';
import { dataDirectory } from '../storage/paths.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = dataDirectory({ root });
const routes = new RouteStore(directory);
let browser: BrowserSession | undefined;
let server: ReturnType<typeof createServer> | undefined;
let shuttingDown = false;
let initializing: Promise<void> | undefined;
let closing: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shuttingDown = true;
  return closing ??= (async () => {
    await initializing?.catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  })();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  initializing = (async () => {
    await routes.load();
    if (shuttingDown) return;
    browser = await createBrowserSession(directory, routes);
    if (shuttingDown) return;
    await browser.initialize();
  })();
  await initializing;
  if (shuttingDown) await shutdown();
  else if (!browser) throw new Error('Session initialization did not complete');
  else if (process.argv.includes('--login')) {
    const login = await browser.login();
    process.stderr.write(`${login.instruction}\n`);
    await login.closed;
    await shutdown();
  } else {
    const organizer = new Organizer(browser, routes);
    server = createServer({ organizer, browser, routes });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stdin.once('end', () => void shutdown());
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
  await shutdown();
  process.exitCode = 1;
}
