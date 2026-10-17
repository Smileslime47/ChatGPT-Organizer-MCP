export type Operation =
  | 'list_projects'
  | 'list_project_conversations'
  | 'create_project'
  | 'rename_project'
  | 'move_conversation';

export interface RequestSpec {
  path: string;
  method?: string;
  body?: unknown;
}

export interface Backend {
  request(spec: RequestSpec): Promise<unknown>;
}

export interface Route {
  method: string;
  pathname: string;
  query: [string, string][];
  body?: unknown;
  learned_at?: string;
}

export type Params = Record<string, unknown>;

export type Action =
  | { type: 'rename_conversation'; conversation_id: string; title: string }
  | { type: 'archive_conversation'; conversation_id: string; archived: boolean }
  | { type: 'create_project'; name: string }
  | { type: 'rename_project'; project_id: string; name: string }
  | { type: 'move_conversation'; conversation_id: string; project_id: string };

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  create_time: unknown;
  update_time: unknown;
  is_archived: unknown;
  project_id: unknown;
  messages?: ConversationMessage[];
  note?: string;
}

export interface Pagination {
  offset?: number;
  limit?: number;
  cursor?: string;
  after?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
