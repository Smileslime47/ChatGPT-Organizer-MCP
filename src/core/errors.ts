export interface ErrorResult {
  code: string;
  message: string;
  [key: string]: unknown;
}

export class OrganizerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error: unknown): ErrorResult {
  // Never forward raw browser/network exceptions: they may include request data.
  return error instanceof OrganizerError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'INTERNAL_ERROR', message: '操作失败；请检查浏览器窗口或本机配置。原始异常未输出，以免泄露会话数据。' };
}
