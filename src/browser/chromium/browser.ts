import { chromium, type BrowserContext, type Page } from 'playwright';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { OrganizerError } from '../../core/errors.js';
import { ORIGIN } from '../../core/routes.js';
import { PageSession } from '../page.js';
import type { LoginHandle } from '../../core/session.js';
import type { RouteRecorder } from '../../core/routes.js';
import { resolveBrowser } from './launch.js';

type BrowserLauncher = (directory: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => Promise<BrowserContext>;

export class BrowserBackend extends PageSession {
  context: BrowserContext | null = null;
  opening: Promise<void> | null = null;

  constructor(directory: string, routes: RouteRecorder,
    private readonly launchBrowser: BrowserLauncher = async (profile, options) => {
      const browser = await resolveBrowser(dirname(profile));
      return chromium.launchPersistentContext(profile, { ...options, executablePath: browser.executablePath });
    }) {
    super(directory, routes);
  }

  async open(): Promise<void> {
    if (this.context && this.page && !this.page.isClosed()) return;
    if (this.opening) return this.opening;
    this.opening = this.launch();
    try { await this.opening; } finally { this.opening = null; }
  }

  async launch(): Promise<void> {
    if (this.context) await this.context.close();
    this.context = null;
    this.page = null;
    let page: Page;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.context = await this.launchBrowser(join(this.directory, 'browser'), {
        headless: false,
        chromiumSandbox: true,
        viewport: null,
      });
      this.context.on('close', () => { this.context = null; this.page = null; this.accountHeader = undefined; this.recording = null; });
      this.context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== ORIGIN || !url.pathname.startsWith('/backend-api/')) return;
        const account = request.headers()['chatgpt-account-id'];
        if (account) this.accountHeader = account;
      });
      this.context.on('response', response => {
        if (!this.recording) return;
        const task = this.capture(response).catch(() => {});
        this.pendingCaptures.add(task);
        void task.finally(() => this.pendingCaptures.delete(task));
      });
      page = this.context.pages()[0] ?? await this.context.newPage();
      this.page = page;
    } catch (error) {
      if (this.context) await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      if (error instanceof OrganizerError) throw error;
      throw new OrganizerError('BROWSER_LAUNCH_FAILED', '无法启动专用浏览器。请检查所选浏览器是否已安装、配置的浏览器路径或通道是否有效，以及专用浏览器目录是否被其他进程占用。');
    }
    try {
      await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
      throw new OrganizerError('BROWSER_NAVIGATION_FAILED', '浏览器已启动，但未能打开 ChatGPT。窗口已保留，请检查网页提示和网络，或在窗口中手动打开 https://chatgpt.com。');
    }
  }

  async login(): Promise<LoginHandle> {
    await this.open();
    const context = this.context;
    return {
      instruction: '请在浏览器窗口完成 ChatGPT 登录。关闭专用窗口后命令结束。',
      closed: context ? new Promise<void>(resolve => context.once('close', () => resolve())) : Promise.resolve(),
    };
  }

  async close(): Promise<void> { await this.context?.close(); }
}
