import { isRecord } from './types.js';

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing options element: ${id}`);
  return value;
}
const connectElement = element('connect');
const saveElement = element('save');
const portElement = element('port');
if (!(connectElement instanceof HTMLButtonElement) || !(saveElement instanceof HTMLButtonElement) || !(portElement instanceof HTMLInputElement)) throw new Error('Invalid options form');
const connectButton: HTMLButtonElement = connectElement;
const saveButton: HTMLButtonElement = saveElement;
const portInput: HTMLInputElement = portElement;
let busy = false;
let recording = false;
function updateControls(): void {
  connectButton.disabled = busy || recording;
  saveButton.disabled = busy || recording;
  portInput.disabled = busy || recording;
}
function render(value: unknown): void {
  if (!isRecord(value)) throw new Error('Invalid connection status');
  element('service').textContent = value.connected === true ? '已连接' : '等待服务启动';
  element('chatgpt').textContent = value.logged_in === true ? '已登录' : '等待登录';
  element('page').textContent = typeof value.tab_title === 'string' ? `使用页面：${value.tab_title}` : '';
  element('status').textContent = typeof value.message === 'string' ? value.message : '';
  recording = value.recording === true;
  updateControls();
}
async function refresh(): Promise<void> {
  if (busy) return;
  try { render(await chrome.runtime.sendMessage({ type: 'connection_status' })); }
  catch { element('status').textContent = '扩展正在重新加载，请稍后重试。'; }
}
async function connect(): Promise<void> {
  busy = true; updateControls();
  element('status').textContent = '正在连接…';
  try { render(await chrome.runtime.sendMessage({ type: 'connect' })); }
  catch { element('status').textContent = '暂时无法连接，请确认 MCP 服务已启动。'; }
  finally { busy = false; updateControls(); }
}
connectButton.addEventListener('click', () => void connect());
element('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || recording) return;
  const bridgePort = Number(portInput.value);
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) { element('status').textContent = '端口应为 1 到 65535 之间的整数。'; return; }
  void chrome.storage.local.set({ bridgePort }).then(connect).catch(() => { element('status').textContent = '无法保存端口，请重试。'; });
});
const saved = await chrome.storage.local.get('bridgePort');
if (typeof saved.bridgePort === 'number' && Number.isInteger(saved.bridgePort) && saved.bridgePort > 0 && saved.bridgePort <= 65535) portInput.value = String(saved.bridgePort);
await refresh();
setInterval(() => void refresh(), 3000);
