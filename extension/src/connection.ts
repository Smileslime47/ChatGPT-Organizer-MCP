import { pageTask } from './page.js';
import { isRecord, validConfig, type BridgeConfig, type ConnectionStatus } from './types.js';

type ChatGPTTab = chrome.tabs.Tab & { id: number };
export interface SelectedTab { tab: ChatGPTTab; loggedIn: boolean }
export class ConnectionError extends Error {}

function usableTab(tab: chrome.tabs.Tab): tab is ChatGPTTab {
  if (tab.id === undefined || tab.incognito || !tab.url) return false;
  try { return new URL(tab.url).origin === 'https://chatgpt.com'; } catch { return false; }
}

export class BrowserConnection {
  config: BridgeConfig | undefined;
  private pairing: Promise<BridgeConfig> | undefined;
  private client: Promise<string> | undefined;
  private recording: { tabId: number; expires: number } | undefined;
  private errorMessage: string | undefined;

  get recordingTabId(): number | undefined {
    if (this.recording && Date.now() >= this.recording.expires) this.recording = undefined;
    return this.recording?.tabId;
  }
  beginRecording(tabId: number): void { this.recording = { tabId, expires: Date.now() + 600000 }; }
  endRecording(): void { this.recording = undefined; }

  async configuration(forcePair = false): Promise<BridgeConfig> {
    if (this.recordingTabId !== undefined && this.config) return this.config;
    if (this.pairing) return this.pairing;
    const state = await chrome.storage.local.get(['bridge', 'bridgePort']);
    if (this.pairing) return this.pairing;
    const port: unknown = state.bridgePort ?? 43127;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectionError('连接端口必须在 1–65535 之间。');
    const url = `http://127.0.0.1:${port}`;
    if (!forcePair && validConfig(state.bridge) && state.bridge.url === url) {
      this.config = state.bridge; return state.bridge;
    }
    this.pairing = this.pair(url);
    try { return await this.pairing; } finally { this.pairing = undefined; }
  }
  private clientId(): Promise<string> {
    this.client ??= (async () => {
      const state = await chrome.storage.local.get('clientId');
      const stored: unknown = state.clientId;
      if (typeof stored === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) return stored;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ clientId: id });
      return id;
    })();
    return this.client;
  }
  private async pair(url: string): Promise<BridgeConfig> {
    const response = await fetch(`${url}/pair`, {
      method: 'POST', headers: { 'x-chatgpt-organizer': '1', 'x-chatgpt-organizer-client': await this.clientId() },
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      this.errorMessage = response.status === 409 ? '该服务已连接另一个浏览器，请重启 MCP 后再连接。' : '自动连接失败，请检查 MCP 服务和扩展版本。';
      throw new ConnectionError(this.errorMessage);
    }
    const config: unknown = await response.json();
    if (!validConfig(config) || config.url !== url) throw new ConnectionError('MCP 服务返回了无效的连接信息。');
    this.config = config;
    await chrome.storage.local.set({ bridge: config });
    await this.markConnected(true);
    return config;
  }
  async request(config: BridgeConfig, path: string, data?: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(config.url + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'x-chatgpt-organizer-client': await this.clientId(), ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
    });
  }
  async markConnected(connected: boolean): Promise<void> {
    if (connected) this.errorMessage = undefined;
    await chrome.storage.session.set({ lastConnected: connected ? Date.now() : 0 });
  }
  private async getTab(id: unknown): Promise<ChatGPTTab | undefined> {
    if (typeof id !== 'number' || !Number.isInteger(id)) return undefined;
    try { const tab = await chrome.tabs.get(id); return usableTab(tab) ? tab : undefined; } catch { return undefined; }
  }
  private async loggedIn(tab: ChatGPTTab): Promise<boolean> {
    try {
      const replies = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED', func: pageTask, args: [JSON.stringify({ type: 'status' })],
      });
      const result: unknown = replies[0]?.result;
      return isRecord(result) && result.logged_in === true;
    } catch { return false; }
  }
  async selectTab(open = false): Promise<SelectedTab | undefined> {
    const recordingId = this.recordingTabId;
    if (recordingId !== undefined) {
      const tab = await this.getTab(recordingId);
      return tab ? { tab, loggedIn: await this.loggedIn(tab) } : undefined;
    }
    const [session, local, tabs] = await Promise.all([
      chrome.storage.session.get('tabId'), chrome.storage.local.get('tabId'),
      chrome.tabs.query({ url: 'https://chatgpt.com/*' }),
    ]);
    const preferred = await Promise.all([this.getTab(session.tabId), this.getTab(local.tabId)]);
    const candidates = [...preferred, ...tabs.filter(usableTab).sort((a, b) =>
      Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))];
    const visited = new Set<number>();
    let selected: SelectedTab | undefined;
    for (const tab of candidates) {
      if (!tab || visited.has(tab.id)) continue;
      visited.add(tab.id);
      const candidate = { tab, loggedIn: await this.loggedIn(tab) };
      selected ??= candidate;
      if (candidate.loggedIn) { selected = candidate; break; }
    }
    if (!selected && open) {
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
      if (tab.id !== undefined && !tab.incognito) selected = { tab: { ...tab, id: tab.id }, loggedIn: false };
    }
    if (selected) await chrome.storage.session.set({ tabId: selected.tab.id });
    else await chrome.storage.session.remove('tabId');
    return selected;
  }
  async status(selected?: SelectedTab): Promise<ConnectionStatus> {
    const chosen = selected ?? await this.selectTab();
    const session = await chrome.storage.session.get('lastConnected');
    const lastConnected: unknown = session.lastConnected;
    const connected = typeof lastConnected === 'number' && Date.now() - lastConnected < 45000;
    const loggedIn = chosen?.loggedIn ?? false;
    return {
      connected, logged_in: loggedIn, recording: this.recordingTabId !== undefined,
      ...(chosen?.tab.title ? { tab_title: chosen.tab.title } : {}),
      message: !connected ? this.errorMessage ?? '等待 MCP 服务启动，扩展会自动重连。'
        : !chosen ? '请打开 ChatGPT 并登录。'
        : !loggedIn ? '请在 ChatGPT 页面完成登录。' : '已连接，可以整理会话。',
    };
  }
}
