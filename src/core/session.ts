import type { Backend, Operation, Params } from './types.js';

export interface BackendStatus {
  browser_open: boolean;
  logged_in: boolean;
  action?: string;
  transport?: 'chrome' | 'extension' | 'playwright';
  login_pending?: boolean;
  login_check_failed?: boolean;
  bridge_running?: boolean;
  extension_connected?: boolean;
}

export interface LoginHandle {
  instruction: string;
  closed: Promise<void>;
}

/** A ChatGPT session keeps authentication and requests inside its browser. */
export interface BrowserSession extends Backend {
  initialize(): Promise<void>;
  open(): Promise<void>;
  login(): Promise<LoginHandle>;
  status(): Promise<BackendStatus>;
  startRecording(operation: Operation, examples: Params): Promise<unknown>;
  finishRecording(candidateId?: string, cancel?: boolean): Promise<unknown>;
  close(): Promise<void>;
}
