import { SessionBackend } from '../base.js';
import type { LoginHandle } from '../../core/session.js';
import { ExtensionBridge } from './bridge.js';
import { OrganizerError } from '../../core/errors.js';
import { isRecord, type Operation, type Params, type RequestSpec } from '../../core/types.js';
import type { PageRequest } from '../types.js';
import type { BackendStatus } from '../../core/session.js';
import type { BridgeOptions } from './types.js';
import type { RouteRecorder } from '../../core/routes.js';

// Reuse request serialization, safe response handling and the route recorder.
// Extension commands form a fixed protocol; no JavaScript source or arbitrary
// browser commands cross the bridge.
export class ExtensionBackend extends SessionBackend {
  readonly bridge: ExtensionBridge;
  private finishLogin: (() => void) | undefined;

  constructor(directory: string, routes: RouteRecorder, options?: BridgeOptions) {
    super(directory, routes);
    this.bridge = new ExtensionBridge(directory, options);
    this.bridge.onCapture = async data => {
      if (!this.recording || !isRecord(data) || typeof data.path !== 'string' || typeof data.method !== 'string') return;
      if (!['GET', 'POST', 'PATCH', 'PUT'].includes(data.method)) return;
      const { path, method, body, status } = data;
      if (data.diagnostic) {
        this.recording.diagnostics ??= [];
        if (this.recording.diagnostics.length < 20) this.recording.diagnostics.push({ method, pathname: path.split('?')[0], reason: String(data.diagnostic).slice(0, 100) });
        return;
      }
      if (typeof status !== 'number') return;
      await this.capture({
        ok: () => status >= 200 && status < 300,
        request: () => ({ url: () => `https://chatgpt.com${path}`, method: () => method, postData: () => body === undefined ? null : JSON.stringify(body) }),
      });
    };
  }
  override async initialize(): Promise<void> { await this.bridge.start(); }

  override async login(): Promise<LoginHandle> {
    await this.open();
    const status = await this.status();
    return { instruction: status.action ?? '扩展已连接。请在 ChatGPT 页面完成登录；退出后停止连接服务。',
      closed: new Promise<void>(resolve => { this.finishLogin = resolve; }) };
  }
  override async open(): Promise<void> {
    await this.bridge.start();
    if (this.bridge.connected) await this.bridge.call({ type: 'open' });
  }
  override async status(): Promise<BackendStatus> {
    await this.bridge.start();
    if (!this.bridge.connected) return { transport: 'extension', bridge_running: true, extension_connected: false, browser_open: false, logged_in: false, action: '请加载 ChatGPT Organizer Bridge 扩展并打开 Chrome；扩展会自动连接，请稍后重试。' };
    const status = await this.bridge.call({ type: 'status' });
    if (isRecord(status) && typeof status.error === 'string') throw new OrganizerError('EXTENSION_ERROR', status.error);
    if (!isRecord(status) || typeof status.browser_open !== 'boolean' || typeof status.logged_in !== 'boolean') {
      throw new OrganizerError('EXTENSION_ERROR', '扩展返回了无法识别的状态。');
    }
    return { transport: 'extension', extension_connected: true, browser_open: status.browser_open, logged_in: status.logged_in,
      ...(typeof status.action === 'string' ? { action: status.action } : {}) };
  }
  protected override assertRequestReady(): void {
    if (!this.bridge.connected) throw new OrganizerError('EXTENSION_NOT_CONNECTED', '扩展尚未连接；请加载 ChatGPT Organizer Bridge 扩展并打开 Chrome，稍后重试。');
  }
  protected override evaluateRequest(request: PageRequest): Promise<unknown> {
    return this.bridge.call({ type: 'request', request });
  }
  override async send(request: RequestSpec): Promise<unknown> {
    await this.bridge.start();
    this.assertRequestReady();
    return super.send(request);
  }
  override async startRecording(operation: Operation, examples: Params) {
    const result = await super.startRecording(operation, examples);
    let tabTitle: string | undefined;
    try {
      const reply = await this.bridge.call({ type: 'record_start' });
      if (isRecord(reply) && typeof reply.error === 'string') throw new OrganizerError('EXTENSION_ERROR', reply.error);
      if (isRecord(reply) && typeof reply.tab_title === 'string') tabTitle = reply.tab_title.slice(0, 200);
    } catch (error) { this.recording = null; throw error; }
    return { ...result, ...(tabTitle ? { tab_title: tabTitle } : {}), instruction: `请在已置前的 ChatGPT 标签页${tabTitle ? `（标题：${JSON.stringify(tabTitle)}）` : ''}手动完成一次对应操作，然后调用 chatgpt_record_finish。` };
  }
  override async finishRecording(candidateId?: string, cancel = false) {
    if (!cancel && this.recording) {
      const reply = await this.bridge.call({ type: 'record_flush' });
      if (isRecord(reply) && typeof reply.error === 'string') throw new OrganizerError('EXTENSION_ERROR', reply.error);
      if (!isRecord(reply) || !Array.isArray(reply.captures)) throw new OrganizerError('EXTENSION_UPDATE_REQUIRED', '请重新加载 ChatGPT Organizer Bridge 扩展，然后重新开始记录。');
      for (const data of reply.captures) await this.bridge.onCapture?.(data);
    }
    const result = await super.finishRecording(candidateId, cancel);
    if (result.saved || result.cancelled) await this.bridge.call({ type: 'record_stop' }).catch(() => {});
    return result;
  }
  override async close(): Promise<void> {
    try { await this.bridge.close(); } finally { this.finishLogin?.(); this.finishLogin = undefined; }
  }
}
