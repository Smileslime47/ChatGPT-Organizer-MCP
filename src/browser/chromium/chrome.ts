import { chromium, type Browser, type BrowserContext, type Frame, type Page, type Request, type Response } from 'playwright';
import { PageSession } from '../page.js';
import type { LoginHandle } from '../../core/session.js';
import { OrganizerError } from '../../core/errors.js';
import { ORIGIN, operations } from '../../core/routes.js';
import type { Operation, Params, RequestSpec } from '../../core/types.js';
import type { BackendStatus } from '../../core/session.js';
import type { RouteRecorder } from '../../core/routes.js';

type Connector = () => Promise<Browser>;
const connect: Connector = () => chromium.connectOverCDP('chrome', { noDefaults: true, isLocal: true, timeout: 45000 });
const connectionHelp = '请先在 Chrome 144 或更新版本中打开 chrome://inspect/#remote-debugging，启用远程调试，再调用 chatgpt_open_browser，并亲自允许 Chrome 的连接提示。';
const loginHelp = '请先断开连接，在日常 Chrome 中完成 ChatGPT 登录，再调用 chatgpt_open_browser。';

function isChatGPT(page: Page): boolean {
  try { return !page.isClosed() && new URL(page.url()).origin === ORIGIN; }
  catch { return false; }
}

export class ChromeBackend extends PageSession {
  context: BrowserContext | null = null;
  opening: Promise<void> | null = null;
  private browser: Browser | null = null;
  private selected: Page | null = null;
  private recordingPage: Page | null = null;
  private recordingPageChanged = false;
  private removePageListeners: (() => void) | null = null;
  private readonly connector: Connector;
  private readonly disconnected = () => this.reset();

  constructor(directory: string, routes: RouteRecorder, connector: Connector = connect) {
    super(directory, routes);
    this.connector = connector;
  }

  private queued<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  private reset(): void {
    this.removePageListeners?.();
    this.removePageListeners = null;
    this.browser?.off('disconnected', this.disconnected);
    this.browser = null;
    this.context = null;
    this.page = this.selected = this.recordingPage = null;
    this.recording = null;
    this.recordingPageChanged = false;
    this.accountHeader = undefined;
  }

  private connected(): boolean { return this.browser?.isConnected() === true && this.context !== null; }

  private assertRecordingPage(): void {
    if (this.recording && (this.recordingPageChanged || !this.recordingPage || !isChatGPT(this.recordingPage))) {
      throw new OrganizerError('RECORDING_PAGE_CHANGED', '记录中的 ChatGPT 标签页已关闭或离开 ChatGPT。请调用 chatgpt_record_finish（cancel=true）后重新记录；不会切换到其他标签页。');
    }
  }

  private attach(page: Page): void {
    if (page === this.selected) return;
    this.removePageListeners?.();
    this.page = this.selected = page;
    this.accountHeader = undefined;
    const request = (request: Request) => {
      if (this.selected !== page || !isChatGPT(page) || this.recordingPageChanged) return;
      const url = new URL(request.url());
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/backend-api/')) return;
      const account = request.headers()['chatgpt-account-id'];
      if (account) this.accountHeader = account;
    };
    const response = (response: Response) => {
      if (!this.recording || this.recordingPage !== page || this.recordingPageChanged || !isChatGPT(page)) return;
      const task = this.capture(response).catch(() => {});
      this.pendingCaptures.add(task);
      void task.finally(() => this.pendingCaptures.delete(task));
    };
    const changed = () => {
      this.accountHeader = undefined;
      if (this.recordingPage === page) this.recordingPageChanged = true;
    };
    const navigated = (frame: Frame) => {
      if (frame === page.mainFrame() && !isChatGPT(page)) changed();
    };
    page.on('request', request);
    page.on('response', response);
    page.on('close', changed);
    page.on('framenavigated', navigated);
    this.removePageListeners = () => {
      page.off('request', request);
      page.off('response', response);
      page.off('close', changed);
      page.off('framenavigated', navigated);
    };
  }

  private async loggedIn(page: Page): Promise<boolean> {
    if (!isChatGPT(page)) return false;
    try {
      return await page.evaluate(async () => {
        if (location.origin !== 'https://chatgpt.com') return false;
        const response = await fetch('/api/auth/session', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) return false;
        const session: unknown = await response.json();
        return session !== null && typeof session === 'object' && 'accessToken' in session
          && typeof session.accessToken === 'string' && session.accessToken.length > 0;
      }) === true && isChatGPT(page);
    } catch { return false; }
  }

  private async selectPage(create: boolean): Promise<{ page: Page | null; loggedIn: boolean }> {
    if (!this.connected()) throw new OrganizerError('LOGIN_REQUIRED', connectionHelp);
    this.assertRecordingPage();
    if (this.recording && this.recordingPage) return { page: this.recordingPage, loggedIn: await this.loggedIn(this.recordingPage) };
    const candidates = [...new Set([this.selected, ...this.context!.pages()])]
      .filter((page): page is Page => page !== null && isChatGPT(page));
    for (const page of candidates) {
      if (await this.loggedIn(page)) {
        if (!this.connected()) throw new OrganizerError('LOGIN_REQUIRED', connectionHelp);
        this.attach(page);
        return { page, loggedIn: true };
      }
    }
    if (!this.connected()) throw new OrganizerError('LOGIN_REQUIRED', connectionHelp);
    let page = candidates.find(isChatGPT) ?? null;
    if (!page && create) {
      page = await this.context!.newPage();
      await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!this.connected()) throw new OrganizerError('LOGIN_REQUIRED', connectionHelp);
      if (isChatGPT(page)) this.attach(page);
      return { page, loggedIn: await this.loggedIn(page) };
    }
    if (page) this.attach(page);
    else {
      this.removePageListeners?.();
      this.removePageListeners = null;
      this.page = this.selected = null;
      this.accountHeader = undefined;
    }
    return { page, loggedIn: false };
  }

  override async open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.queued(async () => {
      this.assertRecordingPage();
      if (!this.connected()) {
        this.reset();
        try {
          this.browser = await this.connector();
          this.browser.on('disconnected', this.disconnected);
          this.context = this.browser.contexts()[0] ?? null;
          if (!this.connected()) throw new Error('No default Chrome context');
        } catch {
          const browser = this.browser;
          this.reset();
          await browser?.close().catch(() => {});
          throw new OrganizerError('BROWSER_UNAVAILABLE', connectionHelp);
        }
      }
      try {
        const { page } = await this.selectPage(true);
        await page?.bringToFront();
      } catch (error) {
        if (error instanceof OrganizerError) throw error;
        throw new OrganizerError('BROWSER_UNAVAILABLE', '已连接 Chrome，但无法打开 ChatGPT。请检查浏览器页面和网络后再次调用 chatgpt_open_browser。');
      }
    });
    try { await this.opening; } finally { this.opening = null; }
  }

  override async status(): Promise<BackendStatus> {
    return this.queued(async () => {
      if (!this.connected()) return { transport: 'chrome', browser_open: false, logged_in: false, action: connectionHelp };
      try {
        const { loggedIn } = await this.selectPage(false);
        return { transport: 'chrome', browser_open: true, logged_in: loggedIn, ...(loggedIn ? {} : { action: loginHelp }) };
      } catch (error) {
        if (!this.connected()) return { transport: 'chrome', browser_open: false, logged_in: false, action: connectionHelp };
        if (error instanceof OrganizerError) return { transport: 'chrome', browser_open: true, logged_in: false, action: error.message };
        return { transport: 'chrome', browser_open: true, logged_in: false, action: loginHelp };
      }
    });
  }

  override async login(): Promise<LoginHandle> {
    await this.open();
    const status = await this.status();
    const browser = this.browser;
    return {
      instruction: status.action ?? '已连接 Chrome。退出只断开工具连接，保留浏览器和标签页。',
      closed: browser?.isConnected()
        ? new Promise<void>(resolve => browser.once('disconnected', () => resolve())) : Promise.resolve(),
    };
  }

  override async send(request: RequestSpec): Promise<unknown> {
    const { page, loggedIn } = await this.selectPage(false);
    if (!page || !loggedIn) throw new OrganizerError('LOGIN_REQUIRED', loginHelp);
    return super.send(request);
  }

  override async startRecording(operation: Operation, examples: Params) {
    if (!operations[operation]) throw new OrganizerError('INVALID_OPERATION', '不支持此项目操作。');
    for (const key of operations[operation].required) {
      if (!examples[key]) throw new OrganizerError('MISSING_EXAMPLE', `请提供你将手动使用的 ${key} 示例值。`);
    }
    await this.open();
    return this.queued(async () => {
      if (this.recording) throw new OrganizerError('RECORDING_ACTIVE', '已有接口记录进行中，请先结束它。');
      const { page, loggedIn } = await this.selectPage(false);
      if (!page || !loggedIn) throw new OrganizerError('LOGIN_REQUIRED', loginHelp);
      await page.bringToFront();
      this.recording = { operation, examples, candidates: [], started: Date.now() };
      this.recordingPage = page;
      this.recordingPageChanged = false;
      return { recording: operation, expires_in_seconds: 600, instruction: '现在在已置前的 ChatGPT 标签页手动完成一次对应操作，然后调用 chatgpt_record_finish。记录期间保持此标签页打开；只保存匹配的成功请求模板，不保存令牌、Cookie 或响应正文。' };
    });
  }

  override async finishRecording(candidateId?: string, cancel = false) {
    return this.queued(async () => {
      if (!cancel) this.assertRecordingPage();
      const result = await super.finishRecording(candidateId, cancel);
      if (!this.recording) { this.recordingPage = null; this.recordingPageChanged = false; }
      return result;
    });
  }

  override async close(): Promise<void> {
    await this.queued(async () => {
      const browser = this.browser;
      this.reset();
      // A CDP connection's Browser.close() disconnects Playwright. Closing the
      // default context or a page would instead close the user's own tabs.
      await browser?.close().catch(() => {});
    });
  }
}
