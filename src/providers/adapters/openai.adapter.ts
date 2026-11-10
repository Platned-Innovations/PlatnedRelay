import { ChatChunk, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, emptyUsage, Usage } from '../../gateway/types';
import { AdapterContext, ChatResult, doFetch, httpJson, ProviderAdapter, ProviderError, ProviderRuntime, sseEvents, StreamItem, stripRelayFields, upstreamError } from './base';

/**
 * OpenAI Chat Completions adapter. Also serves every OpenAI-compatible API
 * (DeepSeek, Mistral, Groq, xAI, Together, Fireworks, OpenRouter, Perplexity,
 * Ollama, vLLM, LM Studio, Azure AI Foundry, Bedrock OpenAI endpoint...).
 */
export class OpenAIAdapter implements ProviderAdapter {
  protected url(ctx: { provider: ProviderRuntime }, path: string, _model?: string): string {
    return `${ctx.provider.baseUrl.replace(/\/$/, '')}${path}`;
  }

  protected headers(provider: ProviderRuntime): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.secrets.apiKey) h.Authorization = `Bearer ${provider.secrets.apiKey}`;
    if (provider.config.organization) h['OpenAI-Organization'] = provider.config.organization;
    for (const [k, v] of Object.entries<string>(provider.config.headers ?? {})) h[k] = v;
    for (const [k, v] of Object.entries<string>(safeJson(provider.secrets.headers))) h[k] = v;
    return h;
  }

  protected body(ctx: AdapterContext, req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { ...stripRelayFields(req), model: this.bodyModel(ctx), stream };
    if (ctx.model.capabilities.sampling === false) {
      delete body.temperature;
      delete body.top_p;
    }
    if (stream && ctx.provider.config.streamUsage !== false) body.stream_options = { ...(req.stream_options ?? {}), include_usage: true };
    if (!stream) delete body.stream_options;
    Object.assign(body, req.relay?.providerOptions ?? {});
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return body;
  }

  protected bodyModel(ctx: AdapterContext): string | undefined {
    return ctx.model.providerModelId;
  }

  protected usage(u: any): Usage {
    if (!u) return emptyUsage();
    return {
      inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
      outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      cacheWriteTokens: 0,
    };
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResult> {
    const json = (await httpJson(this.url(ctx, '/chat/completions', ctx.model.providerModelId), {
      method: 'POST',
      headers: this.headers(ctx.provider),
      body: JSON.stringify(this.body(ctx, req, false)),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })) as ChatResponse;
    if (!json?.choices) throw new ProviderError('Upstream response has no choices', 502, true, 'bad_upstream_response');
    const usage = this.usage(json.usage);
    return { response: { ...json, object: 'chat.completion', model: ctx.model.slug }, usage };
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<StreamItem> {
    const res = await doFetch(this.url(ctx, '/chat/completions', ctx.model.providerModelId), {
      method: 'POST',
      headers: { ...this.headers(ctx.provider), Accept: 'text/event-stream' },
      body: JSON.stringify(this.body(ctx, req, true)),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    if (!res.ok) throw upstreamError(res.status, await res.text());
    let usage: Usage | undefined;
    for await (const ev of sseEvents(res)) {
      if (ev.data === '[DONE]') break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if ((chunk as any).error) throw new ProviderError(`Upstream stream error: ${(chunk as any).error?.message ?? 'unknown'}`, 502, false, 'upstream_stream_error');
      if (chunk.usage) usage = this.usage(chunk.usage);
      chunk.model = ctx.model.slug;
      // Usage-only chunks (empty choices) are forwarded too so clients asking for include_usage get it.
      yield { chunk };
    }
    yield { usage: usage ?? { ...emptyUsage(), estimated: true } };
  }

  async embeddings(ctx: AdapterContext, req: EmbeddingRequest): Promise<{ response: EmbeddingResponse; usage: Usage }> {
    const body = { ...stripRelayFields(req), model: this.bodyModel(ctx), ...(req.relay?.providerOptions ?? {}) };
    const json = (await httpJson(this.url(ctx, '/embeddings', ctx.model.providerModelId), {
      method: 'POST',
      headers: this.headers(ctx.provider),
      body: JSON.stringify(body),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })) as EmbeddingResponse;
    return {
      response: { ...json, model: ctx.model.slug },
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
    };
  }

  async listModels(provider: ProviderRuntime, timeoutMs: number): Promise<string[]> {
    const json = await httpJson(this.url({ provider }, '/models'), { method: 'GET', headers: this.headers(provider), timeoutMs });
    return (json.data ?? json.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
  }
}

/**
 * Azure OpenAI (deployment based). The model's providerModelId is the deployment name.
 * Set config.apiVersion (default 2024-10-21). If config.v1 is true, the new /openai/v1 surface is used instead.
 */
export class AzureOpenAIAdapter extends OpenAIAdapter {
  protected override url(ctx: { provider: ProviderRuntime }, path: string, deployment?: string): string {
    const base = ctx.provider.baseUrl.replace(/\/$/, '');
    if (ctx.provider.config.v1) return `${base}/openai/v1${path}`;
    const ver = ctx.provider.config.apiVersion || '2024-10-21';
    if (path === '/models') return `${base}/openai/models?api-version=${ver}`;
    return `${base}/openai/deployments/${encodeURIComponent(deployment ?? '')}${path}?api-version=${ver}`;
  }

  protected override headers(provider: ProviderRuntime): Record<string, string> {
    const h = super.headers(provider);
    delete h.Authorization;
    if (provider.secrets.apiKey) h['api-key'] = provider.secrets.apiKey;
    return h;
  }

  protected override bodyModel(ctx: AdapterContext): string | undefined {
    return ctx.provider.config.v1 ? ctx.model.providerModelId : undefined;
  }
}

export function safeJson(s?: string): Record<string, string> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
