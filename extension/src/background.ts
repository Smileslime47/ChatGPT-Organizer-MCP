import { pageTask } from './page.js';
import { pageRecorder } from './recorder.js';
import { BrowserConnection, ConnectionError } from './connection.js';
import { isBridgeCommand, isRecord, type BridgeCommand, type Capture } from './types.js';

const connection = new BrowserConnection();
let polling: Promise<void> | undefined;
let pollAbort: AbortController | undefined;
let paused = false;
let connecting: Promise<unknown> | undefined;
const captures = new Map<string, Capture & { tabId: number }>();
async function bridgeFetch(path: string, data?: unknown): Promise<Response> {
  return connection.request(await connection.configuration(), path, data);
}
async function execute(command: BridgeCommand): Promise<unknown> {
  const selected = await connection.selectTab(command.type === 'open');
  const tab = selected?.tab;
  if (!tab) {
    const recording = connection.recordingTabId !== undefined;
    if (command.type === 'record_stop') { connection.endRecording(); captures.clear(); return { ok: true }; }
    const action = recording ? '记录所用的 ChatGPT 标签页已关闭，请结束记录后重试。' : '请打开 ChatGPT 并登录，扩展会自动连接。';
    return command.type === 'status' ? { browser_open: false, logged_in: false, action } : { status: 401, error: action };
  }
  if (command.type === 'open') { await chrome.tabs.update(tab.id, { active: true }); return { ok: true }; }
  if (command.type === 'status') return { browser_open: true, logged_in: selected.loggedIn,
    ...(!selected.loggedIn ? { action: '请在 ChatGPT 页面完成登录。' } : {}) };
  if (command.type === 'record_start' || command.type === 'record_flush' || command.type === 'record_stop') {
    const action = command.type.slice(7);
    if (action === 'start' && !selected.loggedIn) return { error: '请在 ChatGPT 页面完成登录后再开始记录。' };
    if (action !== 'start' && connection.recordingTabId === undefined) return action === 'stop' ? { ok: true } : { error: '接口记录已结束或过期，请重新开始记录。' };
    const replies = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageRecorder, args: [action] });
    const result: unknown = replies[0]?.result;
    if (action === 'start' && isRecord(result) && result.ok === true) {
      connection.beginRecording(tab.id); captures.clear();
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      return { ...result, ...(tab.title ? { tab_title: tab.title } : {}) };
    }
    if (action === 'stop') { connection.endRecording(); captures.clear(); }
    return result ?? { error: '无法启用网页请求记录器。' };
  }
  if (command.type !== 'request') return { status: 403 };
  if (!selected.loggedIn) return { status: 401 };
  try {
    const replies = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: pageTask, args: [JSON.stringify(command)] });
    return replies[0]?.result ?? { status: 0 };
  } catch { return { status: 0, error: '无法在 ChatGPT 页面执行请求，请刷新页面后重试。' }; }
}
function poll(): Promise<void> {
  if (!polling) polling = runPoll().finally(() => { polling = undefined; });
  return polling;
}
async function runPoll(): Promise<void> {
  let repaired = false;
  try {
    while (!paused) {
      const config = await connection.configuration();
      if (paused) break;
      pollAbort = new AbortController();
      const response = await connection.request(config, '/poll', undefined, pollAbort.signal);
      pollAbort = undefined;
      if ((response.status === 401 || response.status === 403) && !repaired && connection.recordingTabId === undefined) {
        repaired = true; await connection.configuration(true); continue;
      }
      if (!response.ok) throw new Error('poll failed');
      const envelope: unknown = await response.json();
      if (!isRecord(envelope)) throw new Error('invalid envelope');
      const command = envelope.command;
      repaired = false;
      await connection.markConnected(true);
      if (!command) continue;
      if (!isBridgeCommand(command)) throw new Error('invalid command');
      let result: unknown;
      try { result = await execute(command); } catch { result = { status: 0, error: '无法操作 ChatGPT 页面，请刷新页面后重试。' }; }
      // Never replay a command if the result acknowledgement fails.
      const sent = await connection.request(config, '/result', { id: command.id, result });
      if (!sent.ok) throw new Error('result acknowledgement failed');
    }
  } catch { if (!paused) await connection.markConnected(false); }
  finally { pollAbort = undefined; }
}
function connect(): Promise<unknown> {
  connecting ??= reconnect().finally(() => { connecting = undefined; });
  return connecting;
}
async function reconnect(): Promise<unknown> {
  if (connection.recordingTabId !== undefined) return { ...await connection.status(), message: '请先结束接口记录，再重新连接。' };
  paused = true;
  pollAbort?.abort();
  await polling;
  try {
    if (connection.recordingTabId !== undefined) return { ...await connection.status(), message: '请先结束接口记录，再重新连接。' };
    await connection.configuration(true);
    const selected = await connection.selectTab(true);
    if (selected) await chrome.tabs.update(selected.tab.id, { active: true });
    return await connection.status(selected);
  } catch (error) {
    await connection.markConnected(false);
    return { ...await connection.status(), message: error instanceof ConnectionError ? error.message : '暂时无法连接，请先启动 MCP 服务后重试。' };
  } finally { paused = false; void poll(); }
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (connection.recordingTabId === undefined || details.tabId !== connection.recordingTabId || captures.size >= 100) return;
  if (!['GET', 'POST', 'PATCH', 'PUT'].includes(details.method)) return;
  const url = new URL(details.url);
  if (url.pathname === '/backend-api/conversation') return;
  const base = { method: details.method, path: url.pathname + url.search, tabId: details.tabId };
  const diagnose = (reason: string): void => { captures.set(details.requestId, { ...base, diagnostic: reason }); };
  if (!/^\/backend-api\/(gizmos|projects|conversation|conversations)(\/|$)/.test(url.pathname)) { if (details.method !== 'GET') diagnose('unsupported_path'); return; }
  let body: unknown;
  if (details.requestBody?.raw) {
    try {
      const parts = details.requestBody.raw;
      const size = parts.reduce((sum, part) => sum + (part.bytes?.byteLength ?? 16001), 0);
      if (size > 16000) { diagnose('body_too_large'); return; }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) {
        if (!part.bytes) { diagnose('non_json_body'); return; }
        bytes.set(new Uint8Array(part.bytes), offset); offset += part.bytes.byteLength;
      }
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const unsafe = (value: unknown): boolean => value !== null && typeof value === 'object' && Object.entries(value).some(([key, item]: [string, unknown]) =>
        /token|secret|cookie|authorization|password|email/i.test(key) ||
        (/instructions|messages|prompt/i.test(key) && item !== null && item !== '' && !(Array.isArray(item) && item.length === 0)) || unsafe(item));
      if (unsafe(body)) { diagnose('sensitive_body_field'); return; }
    } catch { diagnose('non_json_body'); return; }
  }
  if (details.requestBody?.formData) { diagnose('form_body_not_supported'); return; }
  captures.set(details.requestId, { ...base, body });
}, { urls: ['https://chatgpt.com/backend-api/*'] }, ['requestBody']);
chrome.webRequest.onCompleted.addListener(details => {
  const captured = captures.get(details.requestId); captures.delete(details.requestId);
  if (!captured || connection.recordingTabId !== captured.tabId) return;
  const failed = details.statusCode < 200 || details.statusCode >= 300;
  void bridgeFetch('/capture', failed ? { method: captured.method, path: captured.path.split('?')[0], diagnostic: `backend_http_${details.statusCode}` } : { ...captured, status: details.statusCode }).catch(() => {});
}, { urls: ['https://chatgpt.com/backend-api/*'] });
chrome.webRequest.onErrorOccurred.addListener(details => { captures.delete(details.requestId); }, { urls: ['https://chatgpt.com/backend-api/*'] });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 }); void chrome.runtime.openOptionsPage(); void poll(); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 }); void poll(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') void poll(); });
chrome.runtime.onMessage.addListener((message: unknown, _sender, reply) => {
  if (isRecord(message) && message.type === 'connect') { void connect().then(reply); return true; }
  if (isRecord(message) && message.type === 'connection_status') { void connection.status().then(reply); return true; }
  return undefined;
});
void poll();
