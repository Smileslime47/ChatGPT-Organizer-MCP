import type { PageRequest } from '../types.js';

export interface BridgeOptions {
  port?: number;
  commandTimeout?: number;
  pollTimeout?: number;
}

export type BridgeCommand =
  | { type: 'request'; request: PageRequest }
  | { type: 'status' | 'open' | 'record_start' | 'record_flush' | 'record_stop' };
