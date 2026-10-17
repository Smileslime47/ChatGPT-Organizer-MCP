import type { Operation, Params, RequestSpec, Route } from '../core/types.js';

export interface PageRequest extends RequestSpec {
  method: string;
  account?: string;
}

export interface BackendResponse {
  status: number;
  data?: unknown;
  retry_after?: string | null;
  validation?: unknown[];
}

// Only the operations used by the transport are required. Browser mocks do not
// need to implement Playwright's unrelated navigation and locator methods.
export interface BrowserPage {
  isClosed(): boolean;
  url(): string;
  evaluate(fn: () => Promise<boolean>): Promise<unknown>;
  evaluate(fn: (args: PageRequest) => Promise<BackendResponse>, args: PageRequest): Promise<unknown>;
}

export interface RecordingResponse {
  ok(): boolean;
  request(): {
    url(): string;
    method(): string;
    postData(): string | null;
  };
}

export interface RecordingDiagnostic {
  method: string;
  pathname: string;
  reason: string;
  body_fields?: string[];
}

export interface Recording {
  operation: Operation;
  examples: Params;
  candidates: { id: string; route: Route; signature: string }[];
  started: number;
  diagnostics?: RecordingDiagnostic[];
}
