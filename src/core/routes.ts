import { OrganizerError } from './errors.js';
import { isRecord } from './types.js';
import type { Operation, Params, RequestSpec, Route } from './types.js';

export const ORIGIN = 'https://chatgpt.com';
export const operations: Record<Operation, { methods: string[]; required: string[] }> = {
  list_projects: { methods: ['GET'], required: [] },
  list_project_conversations: { methods: ['GET'], required: ['project_id'] },
  create_project: { methods: ['POST'], required: ['name'] },
  rename_project: { methods: ['PATCH'], required: ['project_id', 'name'] },
  move_conversation: { methods: ['PATCH', 'PUT', 'POST'], required: ['project_id', 'conversation_id'] },
};
const forbiddenKey = /authorization|cookie|token|secret|password|email|instructions|messages|prompt/i;
const forbiddenPath = /(?:^|\/)(?:delete|remove|share|unshare|invite|members|permissions|files|upload)(?:\/|$)/i;

export function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && Object.hasOwn(operations, value);
}

export function safeBackendPath(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/backend-api/') || /[\\\s#]/.test(path)) {
    throw new OrganizerError('INVALID_ROUTE', '只允许 ChatGPT 的 /backend-api/ 相对地址。');
  }
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/backend-api/') || /%2e|%2f|%5c/i.test(url.pathname)) {
    throw new OrganizerError('INVALID_ROUTE', '接口路径不合法。');
  }
  for (const key of url.searchParams.keys()) {
    if (forbiddenKey.test(key)) throw new OrganizerError('INVALID_ROUTE', '接口地址包含敏感参数。');
  }
  return url.pathname + url.search;
}

function walk(value: unknown, visit: (value: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map(v => walk(v, visit));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const emptyContent = /instructions|messages|prompt/i.test(key) && (item === null || item === '' || (Array.isArray(item) && item.length === 0));
      if ((forbiddenKey.test(key) && !emptyContent) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new OrganizerError('UNSAFE_CAPTURE', '请求含敏感或非整理字段，未记录。');
      }
      return [key, walk(item, visit)];
    }));
  }
  return visit(value);
}

// A reusable rename must not copy the calibration project's settings.
function boundFields(value: unknown): unknown {
  if (value === '{{name}}' || value === '{{project_id}}') return value;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([key, item]) => [key, boundFields(item)]).filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function learnRoute(operation: Operation, request: RequestSpec, examples: Params): Route | null {
  const spec = operations[operation];
  if (!spec || !request.method || !spec.methods.includes(request.method)) return null;
  let path: string;
  try { path = safeBackendPath(request.path); } catch { return null; }
  const url = new URL(path, ORIGIN);
  if (!/^\/backend-api\/(?:gizmos|projects|conversation|conversations)(?:\/|$)/.test(url.pathname) || forbiddenPath.test(url.pathname)) return null;
  if (/^\/backend-api\/conversation(?:\/(?:init|prepare))?$/.test(url.pathname)) return null;
  const found = new Set<string>();
  const entries = Object.entries(examples).filter((entry): entry is [string, string] => spec.required.includes(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0);
  if (new Set(entries.map(([, value]) => value)).size !== entries.length) return null;
  const bind = (value: unknown): unknown => {
    const match = entries.find(([, example]) => value === example);
    if (!match) return value;
    found.add(match[0]);
    return `{{${match[0]}}}`;
  };
  const pathname = url.pathname.split('/').map(part => bind(decodeURIComponent(part))).join('/');
  const query: [string, string][] = [...url.searchParams].map(([key, value]) => [key, String(bind(value))]);
  let body: unknown;
  try { body = request.body === undefined ? undefined : walk(request.body, bind); } catch { return null; }
  if (operation === 'rename_project' && body !== undefined) body = boundFields(body);
  if (!spec.required.every(key => found.has(key))) return null;
  const route: Route = { method: request.method, pathname, query, ...(body === undefined ? {} : { body }), learned_at: new Date().toISOString() };
  try { validateRoute(operation, route); } catch { return null; }
  return route;
}

function isQuery(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.every(entry => Array.isArray(entry) && entry.length === 2 && entry.every(part => typeof part === 'string'));
}

export function validateRoute(operation: Operation, input: unknown): Route {
  const spec = operations[operation];
  if (!spec || !isRecord(input) || typeof input.method !== 'string' || typeof input.pathname !== 'string' || !spec.methods.includes(input.method) || !isQuery(input.query) || (input.learned_at !== undefined && typeof input.learned_at !== 'string')) {
    throw new OrganizerError('INVALID_ROUTE', '项目接口配置不合法。');
  }
  const route: Route = {
    method: input.method, pathname: input.pathname, query: input.query,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.learned_at === undefined ? {} : { learned_at: input.learned_at }),
  };
  const text = JSON.stringify(input);
  if (/^\/backend-api\/conversation(?:\/(?:init|prepare))?$/.test(route.pathname)) throw new OrganizerError('INVALID_ROUTE', '页面初始化请求不是整理接口。');
  if (text.length > 16000 || forbiddenPath.test(route.pathname)) throw new OrganizerError('INVALID_ROUTE', '项目接口超出允许范围。');
  if (!/^\/backend-api\/(?:gizmos|projects|conversation|conversations)\//.test(route.pathname) && !['/backend-api/gizmos', '/backend-api/projects'].includes(route.pathname)) throw new OrganizerError('INVALID_ROUTE', '不支持此项目接口。');
  for (const match of text.matchAll(/\{\{([^}]+)\}\}/g)) {
    if (!spec.required.includes(match[1])) throw new OrganizerError('INVALID_ROUTE', '项目接口含未知参数。');
  }
  for (const key of spec.required) {
    if (!text.includes(`{{${key}}}`)) throw new OrganizerError('INVALID_ROUTE', `接口缺少 ${key} 参数。`);
  }
  if (route.method === 'GET' && route.body !== undefined) throw new OrganizerError('INVALID_ROUTE', 'GET 请求不能包含请求体。');
  if (route.body !== undefined) walk(route.body, value => value);
  if (operation === 'rename_project' && JSON.stringify(route.body) !== JSON.stringify(boundFields(route.body))) throw new OrganizerError('INVALID_ROUTE', '项目改名模板不能包含说明、图标等其他设置。');
  renderRoute(route, Object.fromEntries(spec.required.map(key => [key, 'validation'])));
  return route;
}

export function renderRoute(route: Route, params: Params): RequestSpec {
  const replace = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const match = /^\{\{([^}]+)\}\}$/.exec(value);
    if (!match) return value;
    const replacement = params[match[1]];
    if (typeof replacement !== 'string' || !replacement) throw new OrganizerError('MISSING_PARAMETER', `缺少 ${match[1]}。`);
    return replacement;
  };
  const pathname = route.pathname.split('/').map(part => encodeURIComponent(String(replace(part)))).join('/');
  const query = new URLSearchParams(route.query.map(([key, value]) => [key, String(replace(value))]));
  return {
    method: route.method,
    path: safeBackendPath(pathname + (query.size ? `?${query}` : '')),
    ...(route.body === undefined ? {} : { body: walk(route.body, replace) }),
  };
}

export interface RouteRecorder {
  save(operation: Operation, route: Route): Promise<unknown>;
}

export interface RouteRepository extends RouteRecorder {
  get(operation: Operation, params?: Params): RequestSpec;
  status(): Record<string, 'calibrated' | 'needs_calibration'>;
}
