import { randomUUID } from 'node:crypto';
import { OrganizerError } from '../core/errors.js';
import { ORIGIN, operations, learnRoute, safeBackendPath } from '../core/routes.js';
import { isRecord, type Operation, type Params, type RequestSpec } from '../core/types.js';
import type { BackendResponse, PageRequest, Recording, RecordingResponse } from './types.js';
import type { BackendStatus, BrowserSession, LoginHandle } from '../core/session.js';
import type { RouteRecorder } from '../core/routes.js';

/** Shared request and recording behavior, independent of a browser driver. */
export abstract class SessionBackend implements BrowserSession {
  readonly directory: string;
  readonly routes: RouteRecorder;
  recording: Recording | null = null;
  readonly pendingCaptures = new Set<Promise<void>>();
  accountHeader: string | undefined;
  queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, routes: RouteRecorder) {
    this.directory = directory;
    this.routes = routes;
  }

  async initialize(): Promise<void> {}
  abstract open(): Promise<void>;
  abstract login(): Promise<LoginHandle>;
  abstract status(): Promise<BackendStatus>;
  abstract close(): Promise<void>;
  protected abstract assertRequestReady(): void;
  protected abstract evaluateRequest(args: PageRequest): Promise<unknown>;

  async request(request: RequestSpec): Promise<unknown> {
    const run = this.queue.then(() => this.send(request));
    this.queue = run.catch(() => {});
    return run;
  }

  async send({ method = 'GET', path, body }: RequestSpec): Promise<unknown> {
    path = safeBackendPath(path);
    if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method)) throw new OrganizerError('INVALID_METHOD', '不支持此请求方法。');
    this.assertRequestReady();
    let result: BackendResponse;
    try {
      const raw = await this.evaluateRequest({ method, path, body, account: this.accountHeader });
      if (!isRecord(raw) || typeof raw.status !== 'number' || !Number.isFinite(raw.status)) result = { status: 502 };
      else result = {
        status: raw.status,
        data: raw.data,
        ...(typeof raw.retry_after === 'string' ? { retry_after: raw.retry_after } : {}),
        ...(Array.isArray(raw.validation) ? { validation: raw.validation } : {}),
      };
    } catch { result = { status: 0 }; }
    if (result.status >= 200 && result.status < 300) return result.data;
    const messages: Record<number, readonly [string, string]> = {
      0: ['REQUEST_UNCERTAIN', '网络中断或请求超时。写入结果可能不确定；先查询实际状态，不要直接重试。'],
      401: ['LOGIN_REQUIRED', '登录已失效，请调用 chatgpt_open_browser，按提示在 ChatGPT 官方页面重新登录。'],
      403: ['ACCESS_DENIED', 'ChatGPT 拒绝请求；请检查网页验证和账号权限。不会自动绕过验证。'],
      404: ['ENDPOINT_CHANGED', '接口或对象不存在，可能需要重新校准项目接口。'],
      413: ['RESPONSE_TOO_LARGE', '响应过大，请缩小查询范围。'],
      422: ['INVALID_BACKEND_PARAMETERS', '后台拒绝了请求参数；请检查接口字段和分页上限，必要时重新校准。'],
      429: ['RATE_LIMITED', 'ChatGPT 限流，请稍后重试；本次未自动重放请求。'],
      502: ['UNEXPECTED_RESPONSE', '接口返回了非 JSON 数据；请检查网页或重新校准。'],
    };
    const [code, message] = messages[result.status] ?? ['BACKEND_ERROR', 'ChatGPT 后台请求失败。'];
    const retryAfter = /^\d{1,6}$/.test(result.retry_after ?? '') ? Number(result.retry_after) : undefined;
    throw new OrganizerError(code, message, { status: result.status, method, pathname: new URL(path, ORIGIN).pathname,
      ...(result.status === 422 && isRecord(body) ? { body_fields: Object.keys(body), null_fields: Object.keys(body).filter(key => body[key] === null) } : {}),
      ...(Array.isArray(result.validation) ? { validation: result.validation } : {}), ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }) });
  }

  async startRecording(operation: Operation, examples: Params) {
    if (!operations[operation]) throw new OrganizerError('INVALID_OPERATION', '不支持此项目操作。');
    if (this.recording) throw new OrganizerError('RECORDING_ACTIVE', '已有接口记录进行中，请先结束它。');
    for (const key of operations[operation].required) {
      if (!examples[key]) throw new OrganizerError('MISSING_EXAMPLE', `请提供你将手动使用的 ${key} 示例值。`);
    }
    await this.open();
    this.assertRequestReady();
    this.recording = { operation, examples, candidates: [], started: Date.now() };
    return { recording: operation, expires_in_seconds: 600, instruction: '现在在专用浏览器里手动完成一次对应操作，然后调用 chatgpt_record_finish。记录器只保存匹配的成功请求模板，不保存令牌、Cookie 或响应正文。' };
  }

  async capture(response: RecordingResponse): Promise<void> {
    const recording = this.recording;
    if (!recording || Date.now() - recording.started > 600000 || !response.ok()) return;
    const request = response.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/backend-api/')) return;
    const text = request.postData();
    if (text && text.length > 16000) return;
    let body: unknown;
    if (text) { try { body = JSON.parse(text); } catch { return; } }
    const route = learnRoute(recording.operation, { method: request.method(), path: url.pathname + url.search, body }, recording.examples);
    if (!route || this.recording !== recording) {
      if (this.recording === recording) {
        recording.diagnostics ??= [];
        if (recording.diagnostics.length < 20) recording.diagnostics.push({ method: request.method(), pathname: url.pathname, body_fields: body && typeof body === 'object' ? Object.keys(body) : [], reason: 'no_matching_template' });
      }
      return;
    }
    // Collapse duplicates caused by React/query refetches.
    const signature = JSON.stringify({ ...route, learned_at: undefined });
    if (!recording.candidates.some(item => item.signature === signature) && recording.candidates.length < 20) {
      recording.candidates.push({ id: randomUUID(), route, signature });
    }
  }

  async finishRecording(candidateId?: string, cancel = false) {
    await Promise.all([...this.pendingCaptures]);
    const recording = this.recording;
    if (!recording) throw new OrganizerError('NO_RECORDING', '当前没有接口记录。');
    if (cancel) { this.recording = null; return { cancelled: true as const }; }
    const candidates = recording.candidates;
    const selected = candidateId ? candidates.find(item => item.id === candidateId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) return {
      saved: false as const, operation: recording.operation,
      diagnostics: recording.diagnostics ?? [],
      candidates: candidates.map(({ id, route }) => ({ id, method: route.method, pathname: route.pathname, query: route.query, body: route.body })),
      instruction: candidates.length ? '请根据刚才的网页操作选择正确 candidate_id，再调用本工具。' : '没有匹配的成功请求；检查示例值是否与网页操作一致，或取消后重新记录。',
    };
    await this.routes.save(recording.operation, selected.route);
    this.recording = null;
    return { saved: true as const, operation: recording.operation, route: selected.route };
  }
}
