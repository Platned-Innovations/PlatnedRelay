import { ChatChunk, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, Usage } from '../../gateway/types';

export interface ModelCapabilities {
  vision?: boolean;
  tools?: boolean;
  streaming?: boolean;
  json?: boolean;
  /** false => temperature/top_p are stripped (e.g. newer Claude models reject them). */
  sampling?: boolean;
  reasoning?: boolean;
}

export interface ProviderRuntime {
  id: string;
  slug: string;
  type: ProviderType;
  baseUrl: string;
  config: Record<string, any>;
  secrets: Record<string, string>;
}

export interface ModelRuntime {
  id: string;
  slug: string;
  providerModelId: string;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
}

export interface AdapterContext {
  provider: ProviderRuntime;
  model: ModelRuntime;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  response: ChatResponse;
  usage: Usage;
}

/** Streaming yields OpenAI-format chunks; the final `usage` item carries token counts. */
export type StreamItem = { chunk: ChatChunk } | { usage: Usage };

export interface ProviderAdapter {
  chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResult>;
  chatStream(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<StreamItem>;
  embeddings?(ctx: AdapterContext, req: EmbeddingRequest): Promise<{ response: EmbeddingResponse; usage: Usage }>;
  listModels?(provider: ProviderRuntime, timeoutMs: number): Promise<string[]>;
}

export type ProviderType = 'openai' | 'azure-openai' | 'anthropic' | 'gemini' | 'custom';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly code = 'provider_error',
    public readonly upstreamBody?: string,
  ) {
    super(message);
  }
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function httpJson(url: string, init: RequestInit & { timeoutMs: number; signal?: AbortSignal }): Promise<any> {
  const res = await doFetch(url, init);
  const text = await res.text();
  if (!res.ok) throw upstreamError(res.status, text);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError('Upstream returned invalid JSON', 502, true, 'bad_upstream_response', text.slice(0, 500));
  }
}

export async function doFetch(url: string, init: RequestInit & { timeoutMs: number; signal?: AbortSignal }): Promise<Response> {
  const signals = [AbortSignal.timeout(init.timeoutMs)];
  if (init.signal) signals.push(init.signal);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (e: any) {
    if (e?.name === 'TimeoutError') throw new ProviderError(`Upstream timed out after ${init.timeoutMs}ms`, 504, true, 'upstream_timeout');
    if (e?.name === 'AbortError') throw new ProviderError('Request aborted by client', 499, false, 'client_aborted');
    throw new ProviderError(`Upstream connection failed: ${e?.cause?.code || e?.message}`, 502, true, 'upstream_unreachable');
  }
}

export function upstreamError(status: number, body: string): ProviderError {
  let msg = body.slice(0, 500);
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.message || j?.error?.type || (typeof j?.error === 'string' ? j.error : msg);
  } catch {
    /* keep raw */
  }
  return new ProviderError(`Upstream error ${status}: ${msg}`, status >= 400 && status < 600 ? status : 502, isRetryableStatus(status), 'upstream_error', body.slice(0, 2000));
}

/** Parses a text/event-stream body into {event, data} records. */
export async function* sseEvents(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

export function stripRelayFields<T extends Record<string, any>>(req: T): T {
  const { relay, ...rest } = req as any;
  return rest;
}

export function chunkId() {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
