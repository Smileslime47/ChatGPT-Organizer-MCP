import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { BrowserBackend } from './browser.js';
import { openLoginBrowser } from './launch.js';
import { OrganizerError } from '../../core/errors.js';
import type { LoginHandle } from '../../core/session.js';
import type { BackendStatus } from '../../core/session.js';
import type { RouteRecorder } from '../../core/routes.js';

interface StandaloneOptions {
  launchBrowser?: ConstructorParameters<typeof BrowserBackend>[2];
  loginLauncher?: typeof openLoginBrowser;
  hasProfile?: () => boolean;
}

/** Authentication uses an ordinary window; only the working session is controlled. */
export class StandaloneBackend extends BrowserBackend {
  private loginWindow: ChildProcess | null = null;
  private loginHandle: LoginHandle | null = null;
  private finishLogin: (() => void) | undefined;
  private connecting: Promise<void> | null = null;
  private readonly loginLauncher: typeof openLoginBrowser;
  private readonly hasProfile: () => boolean;

  constructor(directory: string, routes: RouteRecorder, options: StandaloneOptions = {}) {
    super(directory, routes, options.launchBrowser);
    this.loginLauncher = options.loginLauncher ?? openLoginBrowser;
    this.hasProfile = options.hasProfile ?? (() => existsSync(join(directory, 'browser')));
  }

  private loginRunning(): boolean {
    return !!this.loginWindow && this.loginWindow.exitCode === null && this.loginWindow.signalCode === null;
  }

  override async open(): Promise<void> {
    if (this.connecting) return this.connecting;
    const run = this.queue.then(() => this.connect());
    this.connecting = run;
    this.queue = run.catch(() => {});
    try { await run; } finally { this.connecting = null; }
  }

  private async connect(): Promise<void> {
    if (this.loginRunning()) return;
    const completedLoginAttempt = this.loginWindow !== null;
    this.loginWindow = null;
    if (completedLoginAttempt || this.context || this.hasProfile()) {
      await super.open();
      const status = await super.status();
      if (status.logged_in) return;
      if (status.login_check_failed) throw new OrganizerError('LOGIN_CHECK_FAILED', '暂时无法验证登录。窗口已保留，请检查网络或网页验证提示后重试连接。');
    }
    await this.beginLogin();
  }

  private async beginLogin(): Promise<void> {
    if (this.loginRunning()) return;
    await super.close();
    this.loginWindow = await this.loginLauncher(this.directory);
    // The user may still be entering credentials when the MCP client exits.
    this.loginWindow.unref();
  }

  override async login(): Promise<LoginHandle> {
    const run = this.queue.then(() => this.beginLogin());
    this.queue = run.catch(() => {});
    await run;
    if (this.loginHandle) return this.loginHandle;
    const child = this.loginWindow!;
    child.ref();
    const closed = new Promise<void>(resolve => {
      const finish = () => {
        child.off('exit', finish);
        child.unref();
        this.loginHandle = null;
        this.finishLogin = undefined;
        resolve();
      };
      this.finishLogin = finish;
      if (!this.loginRunning()) finish();
      else child.once('exit', finish);
    });
    const handle = { instruction: '请在普通独立窗口中完成 ChatGPT 登录，然后关闭这个专用窗口。下次连接 MCP 时会验证登录。', closed };
    if (this.loginRunning()) this.loginHandle = handle;
    return handle;
  }

  override async status(): Promise<BackendStatus> {
    if (this.loginWindow) return {
      transport: 'playwright', browser_open: this.loginRunning(), logged_in: false,
      login_pending: true,
      action: this.loginRunning()
        ? '请在普通独立窗口中选择 ChatGPT 官方提供的登录方式，完成后关闭这个专用窗口，再调用 chatgpt_open_browser。'
        : '登录窗口已关闭。请调用 chatgpt_open_browser 验证登录并连接；关闭窗口本身不代表登录成功。',
    };
    const status = await super.status();
    return { ...status, transport: 'playwright',
      ...(status.logged_in || status.login_check_failed ? {} : { action: '请调用 chatgpt_open_browser 连接；需要登录时会打开普通独立窗口。' }) };
  }

  override async close(): Promise<void> {
    await this.connecting?.catch(() => {});
    await this.queue.catch(() => {});
    this.finishLogin?.();
    await super.close();
  }
}
