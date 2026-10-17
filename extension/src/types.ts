export interface BridgeConfig {
  version: 1;
  url: string;
  token: string;
}

export interface ConnectionStatus {
  connected: boolean;
  logged_in: boolean;
  tab_title?: string;
  message: string;
  recording?: boolean;
}

export interface BackendRequest {
  path: string;
  method?: string;
  body?: unknown;
  account?: string;
}

export type PageCommand = { type: 'status' } | { type: 'request'; request: BackendRequest };
export type BridgeCommand = (PageCommand | { type: 'open' | 'record_start' | 'record_flush' | 'record_stop' }) & { id: string };

export interface Capture {
  method: string;
  path: string;
  body?: unknown;
  diagnostic?: string;
  status?: number;
}

export interface ValidationDetail {
  location: (string | number)[];
  type: string;
}

export type PageResult = { browser_open: boolean; logged_in: boolean } | {
  status: number;
  data?: unknown;
  retry_after?: string | null;
  validation?: ValidationDetail[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validConfig(value: unknown): value is BridgeConfig {
  return isRecord(value) && value.version === 1 && typeof value.url === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.url) && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token);
}

export function isBridgeCommand(value: unknown): value is BridgeCommand {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (value.type === 'status' || value.type === 'open' || value.type === 'record_start' || value.type === 'record_flush' || value.type === 'record_stop') return true;
  if (value.type !== 'request' || !isRecord(value.request)) return false;
  const request = value.request;
  return typeof request.path === 'string' && (request.method === undefined || typeof request.method === 'string') &&
    (request.account === undefined || typeof request.account === 'string');
}
