/** OpenAI-compatible wire types used as Relay's canonical request/response format. */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: string; [k: string]: unknown };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface RelayExtensions {
  /** Use a managed prompt template. */
  prompt?: { id?: string; slug?: string; version?: number; label?: string; variables?: Record<string, unknown> };
  /** Disable/force the response cache for this request. */
  cache?: boolean | { ttlSeconds?: number };
  /** Free-form tags stored with the usage record (e.g. feature names). */
  tags?: string[];
  /** Extra provider-specific body fields merged into the upstream request. */
  providerOptions?: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: Record<string, unknown> };
  reasoning_effort?: string;
  user?: string;
  seed?: number;
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  relay?: RelayExtensions;
  [k: string]: unknown;
}

export interface ChatChoice {
  index: number;
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; refusal?: string | null };
  finish_reason: string | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: OpenAIUsage;
  [k: string]: unknown;
}

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: 'assistant'; content?: string | null; tool_calls?: (Partial<ToolCall> & { index: number; function?: { name?: string; arguments?: string } })[] };
    finish_reason: string | null;
  }[];
  usage?: OpenAIUsage | null;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
  relay?: RelayExtensions;
}

export interface EmbeddingResponse {
  object: 'list';
  data: { object: 'embedding'; index: number; embedding: number[] | string }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/** Normalised usage. `inputTokens` is the full prompt size including cached / cache-write tokens. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  estimated?: boolean;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });

export function textOf(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? (p as any).text : '')).join('\n');
}

/** Rough token estimate (≈4 chars/token) used when a provider does not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + 4 + estimateTokens(textOf(m.content)) + estimateTokens(JSON.stringify(m.tool_calls ?? '')), 3);
}
