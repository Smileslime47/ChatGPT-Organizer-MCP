import type { Capture } from './types.js';

interface RecorderState {
  captures: Capture[];
  pending: Set<Promise<void>>;
  expires: number;
  stop(): void;
}

type RecorderResult = { captures: Capture[]; recorder_missing?: boolean } | { ok: true } | { error: string };

// Self-contained: Chrome serializes this function into the selected page's
// MAIN world. It observes fetch only while calibration is explicitly armed.
// No headers, cookies, responses or session credentials are collected.
export async function pageRecorder(action: string): Promise<RecorderResult> {
  const key = '__chatgptOrganizerRecorderV1';
  const recorderWindow = window as Window & { __chatgptOrganizerRecorderV1?: RecorderState };
  const previous = recorderWindow[key];
  if (action === 'flush') {
    if (!previous) return { captures: [], recorder_missing: true };
    await Promise.all([...previous.pending]);
    return { captures: previous.captures.splice(0) };
  }
  if (previous) previous.stop();
  if (action === 'stop') return { ok: true };
  if (action !== 'start') return { error: 'Unsupported recorder action' };

  const original = window.fetch;
  const state: RecorderState = {
    captures: [], pending: new Set(), expires: Date.now() + 600000,
    stop() {
      clearTimeout(timer);
      if (window.fetch === wrapped) window.fetch = original;
      if (recorderWindow[key] === state) delete recorderWindow[key];
    },
  };
  const unsafe = (value: unknown): boolean => value !== null && typeof value === 'object' && Object.entries(value).some(([name, item]: [string, unknown]) =>
    /token|secret|cookie|authorization|password|email/i.test(name) ||
    (/instructions|messages|prompt/i.test(name) && item !== null && item !== '' && !(Array.isArray(item) && item.length === 0)) || unsafe(item));
  const describe = async (input: RequestInfo | URL, init?: RequestInit): Promise<Capture | null> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const method = String(init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET').toUpperCase();
    if (url.origin !== 'https://chatgpt.com' || !['PATCH', 'PUT', 'POST'].includes(method) ||
      !/^\/backend-api\/(gizmos|projects|conversation|conversations)(\/|$)/.test(url.pathname) ||
      /^\/backend-api\/conversation(?:\/(init|prepare))?$/.test(url.pathname)) return null;
    const base = { method, path: url.pathname + url.search };
    if ([...url.searchParams.keys()].some(name => /token|secret|cookie|authorization|password|email/i.test(name))) return null;
    let text = init?.body;
    if (text === undefined && input instanceof Request) text = await input.clone().text();
    if (text === undefined || text === null) return base;
    if (typeof text !== 'string') return { ...base, diagnostic: 'non_text_body' };
    if (text.length > 16000) return { ...base, diagnostic: 'body_too_large' };
    try {
      const body: unknown = JSON.parse(text);
      return unsafe(body) ? { ...base, diagnostic: 'sensitive_body_field' } : { ...base, body };
    } catch { return { ...base, diagnostic: 'non_json_body' }; }
  };
  function wrapped(this: Window, ...args: Parameters<typeof fetch>): Promise<Response> {
    if (Date.now() > state.expires) { state.stop(); return original.apply(this, args); }
    const [input, init] = args;
    const description = describe(input, init).catch(() => null);
    const result = original.apply(this, args);
    const task = Promise.all([description, result]).then(([request, response]) => {
      if (!request || recorderWindow[key] !== state || state.captures.length >= 100) return;
      state.captures.push(response.ok ? { ...request, status: response.status }
        : { method: request.method, path: request.path.split('?')[0], diagnostic: `backend_http_${response.status}` });
    }).catch(() => {});
    state.pending.add(task);
    void task.finally(() => state.pending.delete(task));
    return result;
  }
  const timer = setTimeout(() => state.stop(), 600000);
  recorderWindow[key] = state;
  window.fetch = wrapped;
  return { ok: true };
}
