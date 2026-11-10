import { ChatRequest, ChatResponse, estimateMessagesTokens, estimateTokens, textOf } from '../../gateway/types';
import { AdapterContext, ChatResult, chunkId, httpJson, ProviderAdapter, ProviderError, StreamItem } from './base';
import { safeJson } from './openai.adapter';

/**
 * Fully configurable HTTP adapter for in-house or exotic model APIs.
 *
 * provider.config.custom = {
 *   path: "/generate",                       // appended to baseUrl; may contain {{model}}
 *   method: "POST",
 *   headers: { "X-Api-Key": "{{apiKey}}" },  // {{apiKey}} resolved from the encrypted secret
 *   bodyTemplate: { "model": "{{model}}", "input": "{{messages}}", "max_new_tokens": "{{max_tokens}}" },
 *   responseMapping: {
 *     content: "output.text",                 // dot/bracket path into the JSON response
 *     inputTokens: "usage.input", outputTokens: "usage.output", finishReason: "stop_reason"
 *   }
 * }
 *
 * A template string that is exactly "{{var}}" is replaced by the raw value (array/number/object);
 * otherwise placeholders are interpolated as text. Variables: model, messages, prompt, system,
 * last_user, max_tokens, temperature, top_p, stop, tools, user.
 */
export function getPath(obj: any, path?: string): any {
  if (!path) return undefined;
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function renderTemplate(tpl: unknown, vars: Record<string, unknown>): unknown {
  if (typeof tpl === 'string') {
    const exact = tpl.match(/^\{\{\s*([a-zA-Z_]+)\s*\}\}$/);
    if (exact) return vars[exact[1]];
    return tpl.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) => {
      const v = vars[k];
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.map((t) => renderTemplate(t, vars));
  if (tpl && typeof tpl === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tpl)) {
      const r = renderTemplate(v, vars);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return tpl;
}

export class CustomAdapter implements ProviderAdapter {
  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResult> {
    const cfg = ctx.provider.config.custom ?? {};
    if (!cfg.bodyTemplate || !cfg.responseMapping?.content) throw new ProviderError('Custom provider is missing bodyTemplate/responseMapping.content', 500, false, 'provider_misconfigured');
    const prompt = req.messages.map((m) => `${m.role}: ${textOf(m.content)}`).join('\n');
    const vars: Record<string, unknown> = {
      model: ctx.model.providerModelId,
      messages: req.messages,
      prompt,
      system: req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'),
      last_user: textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''),
      max_tokens: req.max_completion_tokens ?? req.max_tokens ?? ctx.model.maxOutputTokens,
      temperature: req.temperature,
      top_p: req.top_p,
      stop: req.stop,
      tools: req.tools,
      user: req.user,
      apiKey: ctx.provider.secrets.apiKey,
    };
    const headers = renderTemplate({ 'Content-Type': 'application/json', ...(cfg.headers ?? {}), ...safeJson(ctx.provider.secrets.headers) }, vars) as Record<string, string>;
    const body = renderTemplate(cfg.bodyTemplate, { ...vars, apiKey: undefined });
    const path = String(renderTemplate(cfg.path ?? '', { model: ctx.model.providerModelId }));
    const json = await httpJson(`${ctx.provider.baseUrl.replace(/\/$/, '')}${path}`, {
      method: cfg.method ?? 'POST',
      headers,
      body: JSON.stringify({ ...(body as object), ...(req.relay?.providerOptions ?? {}) }),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    const map = cfg.responseMapping;
    const content = getPath(json, map.content);
    const text = typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content);
    const inTok = Number(getPath(json, map.inputTokens));
    const outTok = Number(getPath(json, map.outputTokens));
    const estimated = !Number.isFinite(inTok) || !Number.isFinite(outTok);
    const usage = {
      inputTokens: Number.isFinite(inTok) ? inTok : estimateMessagesTokens(req.messages),
      outputTokens: Number.isFinite(outTok) ? outTok : estimateTokens(text),
      cachedTokens: 0,
      cacheWriteTokens: 0,
      estimated,
    };
    const response: ChatResponse = {
      id: chunkId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model.slug,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: String(getPath(json, map.finishReason) ?? 'stop') }],
      usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
    };
    return { response, usage };
  }

  /** Custom APIs are called non-streaming; the result is replayed as a single SSE chunk. */
  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<StreamItem> {
    const { response, usage } = await this.chat(ctx, req);
    const base = { id: response.id, object: 'chat.completion.chunk' as const, created: response.created, model: response.model };
    yield { chunk: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: response.choices[0].message.content }, finish_reason: null }] } };
    yield { chunk: { ...base, choices: [{ index: 0, delta: {}, finish_reason: response.choices[0].finish_reason }] } };
    yield { usage };
  }
}
