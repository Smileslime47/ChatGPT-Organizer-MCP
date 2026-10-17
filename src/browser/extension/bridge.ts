import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OrganizerError } from '../../core/errors.js';
import { isRecord } from '../../core/types.js';
import type { BridgeCommand, BridgeOptions } from './types.js';

interface PendingCommand {
  id: string;
  payload: BridgeCommand;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
}

export class ExtensionBridge {
  readonly directory: string;
  port: number;
  readonly commandTimeout: number;
  readonly pollTimeout: number;
  readonly pending = new Map<string, PendingCommand>();
  waiter: { res: ServerResponse; timer: ReturnType<typeof setTimeout> } | null = null;
  lastSeen = 0;
  server: Server | null = null;
  starting: Promise<void> | null = null;
  readonly configFile: string;
  token: string | undefined;
  url: string | undefined;
  private expectedExtensionOrigin: string | undefined;
  private ownerClientId: string | undefined;
  onCapture?: (data: unknown) => Promise<void>;

  constructor(directory: string, { port = 43127, commandTimeout = 50000, pollTimeout = 20000 }: BridgeOptions = {}) {
    this.directory = directory; this.port = port; this.commandTimeout = commandTimeout; this.pollTimeout = pollTimeout;
    this.configFile = join(directory, 'bridge-config.json');
  }
  get connected(): boolean { return Date.now() - this.lastSeen < 40000; }
  get extensionOrigin(): string | undefined { return this.expectedExtensionOrigin; }
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server) return;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = null; }
  }
  async launch(): Promise<void> {
    try {
      const manifest: unknown = JSON.parse(await readFile(new URL('../../../extension/manifest.json', import.meta.url), 'utf8'));
      if (!isRecord(manifest) || typeof manifest.key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)) throw new Error('missing extension key');
      const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
        .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
      this.expectedExtensionOrigin = `chrome-extension://${id}`;
    } catch { throw new OrganizerError('EXTENSION_MANIFEST_INVALID', '无法读取扩展身份，请检查 extension/manifest.json。'); }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let token: string | undefined;
    try {
      const data: unknown = JSON.parse(await readFile(this.configFile, 'utf8'));
      if (isRecord(data) && typeof data.token === 'string' && /^[a-f0-9]{64}$/.test(data.token)) token = data.token;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw new OrganizerError('BRIDGE_CONFIG_INVALID', '本机扩展配对文件无法读取。');
    }
    this.token = token ?? randomBytes(32).toString('hex');
    const server = createServer((req, res) => void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.respond(res, 400, { error: 'invalid_request' }); else res.end();
    }));
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', resolve); });
    } catch { throw new OrganizerError('BRIDGE_IN_USE', '本机扩展端口被占用；请先关闭另一个 MCP/doctor 实例。'); }
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.close();
      throw new OrganizerError('BRIDGE_UNAVAILABLE', '无法读取扩展连接地址。');
    }
    this.port = address.port;
    this.url = `http://127.0.0.1:${this.port}`;
    try { await writeFile(this.configFile, JSON.stringify({ version: 1, url: this.url, token: this.token }), { mode: 0o600 }); }
    catch { await this.close(); throw new OrganizerError('BRIDGE_CONFIG_INVALID', '无法保存本机扩展配对文件。'); }
  }
  respond(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  clientId(req: IncomingMessage): string | undefined {
    const value = req.headers['x-chatgpt-organizer-client'];
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase() : undefined;
  }
  authorized(req: IncomingMessage): boolean {
    if (req.headers.host !== `127.0.0.1:${this.port}`) return false;
    const clientId = this.clientId(req);
    if (!clientId || (this.ownerClientId && clientId !== this.ownerClientId)) return false;
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    // A profile may reconnect with a cached token after the MCP restarts. Claim
    // ownership before dispatching its first request, just as /pair does.
    this.ownerClientId ??= clientId;
    return true;
  }
  async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      // Node streams expose untyped chunks; check before passing them to Buffer.
      const value: unknown = chunk;
      if (!Buffer.isBuffer(value)) throw new Error('invalid body');
      size += value.length;
      if (size > 8_100_000) throw new Error('too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Origin blocks ordinary websites; it is not authentication against a local
    // process. The client ID keeps browser profiles from sharing this instance.
    if (req.url === '/pair') {
      const clientId = this.clientId(req);
      if (req.method !== 'POST' || req.headers.host !== `127.0.0.1:${this.port}`
        || req.headers.origin !== this.expectedExtensionOrigin || !this.expectedExtensionOrigin
        || req.headers['x-chatgpt-organizer'] !== '1' || !clientId) {
        this.respond(res, 403, { error: 'forbidden' }); return;
      }
      if (this.ownerClientId && this.ownerClientId !== clientId) {
        this.respond(res, 409, { error: 'bridge_in_use' }); return;
      }
      this.ownerClientId = clientId;
      this.respond(res, 200, { version: 1, url: this.url, token: this.token }); return;
    }
    // Pairing does not authorize polling; all remaining routes require the token.
    if (!this.authorized(req)) { this.respond(res, 403, { error: 'forbidden' }); return; }
    if (req.method === 'GET' && req.url === '/poll') {
      this.lastSeen = Date.now();
      if (this.waiter) this.respond(this.waiter.res, 409, { error: 'another_poll' });
      if (this.waiter) clearTimeout(this.waiter.timer);
      const timer = setTimeout(() => { if (this.waiter?.res === res) this.waiter = null; this.respond(res, 200, { command: null }); }, this.pollTimeout);
      this.waiter = { res, timer };
      res.once('close', () => { if (this.waiter?.res === res) { clearTimeout(timer); this.waiter = null; } });
      this.deliver(); return;
    }
    if (req.method === 'POST' && req.url === '/result') {
      const data = await this.readBody(req);
      if (!isRecord(data) || typeof data.id !== 'string') { this.respond(res, 400, { error: 'invalid_request' }); return; }
      const pending = this.pending.get(data.id);
      if (!pending || !pending.delivered) { this.respond(res, 409, { error: 'unknown_command' }); return; }
      clearTimeout(pending.timer); this.pending.delete(data.id); this.lastSeen = Date.now();
      pending.resolve(data.result); this.respond(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && req.url === '/capture') {
      const data = await this.readBody(req);
      await this.onCapture?.(data);
      this.respond(res, 200, { ok: true }); return;
    }
    this.respond(res, 404, { error: 'not_found' });
  }
  deliver(): void {
    const command = [...this.pending.values()].find(item => !item.delivered);
    if (!command || !this.waiter) return;
    const { res, timer } = this.waiter; this.waiter = null; clearTimeout(timer);
    command.delivered = true;
    this.respond(res, 200, { command: { id: command.id, ...command.payload } });
  }
  async call(payload: BridgeCommand): Promise<unknown> {
    await this.start();
    if (!this.connected) throw new OrganizerError('EXTENSION_NOT_CONNECTED', '请加载 ChatGPT Organizer Bridge 扩展并打开 Chrome；扩展会自动连接，请稍后重试。');
    if (this.pending.size > 10) throw new OrganizerError('BRIDGE_BUSY', '浏览器连接繁忙，请稍后再试。');
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OrganizerError('REQUEST_UNCERTAIN', '扩展响应超时；写入结果可能不确定，请查询实际状态后再决定后续操作。'));
      }, this.commandTimeout);
      this.pending.set(id, { id, payload, resolve, reject, timer, delivered: false });
      this.deliver();
    });
  }
  async close(): Promise<void> {
    if (this.waiter) { clearTimeout(this.waiter.timer); this.respond(this.waiter.res, 200, { command: null }); this.waiter = null; }
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new OrganizerError('BRIDGE_CLOSED', '扩展连接已关闭。')); }
    this.pending.clear();
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  }
}
