import { ChatMessage, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, emptyUsage, textOf, ToolCall, Usage } from '../../gateway/types';
import { AdapterContext, ChatResult, chunkId, doFetch, httpJson, ProviderAdapter, ProviderError, ProviderRuntime, sseEvents, StreamItem, upstreamError } from './base';

const FINISH: Record<string, string> = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', PROHIBITED_CONTENT: 'content_filter', BLOCKLIST: 'content_filter' };

function parts(content: ChatMessage['content']): any[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return content
    .map((p: any) => {
      if (p.type === 'text') return { text: p.text };
      if (p.type === 'image_url') {
        const m = String(p.image_url?.url ?? '').match(/^data:([^;]+);base64,(.*)$/);
        return m ? { inlineData: { mimeType: m[1], data: m[2] } } : { fileData: { fileUri: p.image_url?.url, mimeType: 'image/*' } };
      }
      return null;
    })
    .filter(Boolean);
}

/** Converts OpenAI-style messages to Gemini `contents` + `systemInstruction`. */
export function toGemini(messages: ChatMessage[]) {
  const system: string[] = [];
  const contents: { role: 'user' | 'model'; parts: any[] }[] = [];
  const toolNames = new Map<string, string>();
  const push = (role: 'user' | 'model', p: any[]) => {
    if (!p.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...p);
    else contents.push({ role, parts: p });
  };
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') system.push(textOf(m.content));
    else if (m.role === 'assistant') {
      const p = parts(m.content);
      for (const tc of m.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function.name);
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* ignore */
        }
        p.push({ functionCall: { name: tc.function.name, args } });
      }
      push('model', p);
    } else if (m.role === 'tool') {
      const text = textOf(m.content);
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        response = { content: text };
      }
      if (typeof response !== 'object' || response === null || Array.isArray(response)) response = { content: response };
      push('user', [{ functionResponse: { name: toolNames.get(m.tool_call_id ?? '') ?? m.name ?? 'tool', response } }]);
    } else push('user', parts(m.content));
  }
  return { systemInstruction: system.length ? { parts: [{ text: system.join('\n\n') }] } : undefined, contents };
}

export class GeminiAdapter implements ProviderAdapter {
  private base(p: ProviderRuntime) {
    return (p.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  }

  private headers(p: ProviderRuntime): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': p.secrets.apiKey ?? '', ...(p.config.headers ?? {}) };
  }

  body(ctx: AdapterContext, req: ChatRequest) {
    const { systemInstruction, contents } = toGemini(req.messages);
    const gen: Record<string, unknown> = {};
    if (req.temperature !== undefined && ctx.model.capabilities.sampling !== false) gen.temperature = req.temperature;
    if (req.top_p !== undefined && ctx.model.capabilities.sampling !== false) gen.topP = req.top_p;
    const max = req.max_completion_tokens ?? req.max_tokens;
    if (max) gen.maxOutputTokens = max;
    if (req.stop) gen.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    if (req.seed !== undefined) gen.seed = req.seed;
    if (req.response_format?.type === 'json_object' || req.response_format?.type === 'json_schema') gen.responseMimeType = 'application/json';
    const schema = (req.response_format?.json_schema as any)?.schema;
    if (schema) gen.responseJsonSchema = schema;
    const body: Record<string, unknown> = { contents, generationConfig: gen };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
    if (req.tool_choice) {
      const tc = req.tool_choice;
      body.toolConfig = {
        functionCallingConfig:
          tc === 'auto' ? { mode: 'AUTO' } : tc === 'none' ? { mode: 'NONE' } : tc === 'required' ? { mode: 'ANY' } : { mode: 'ANY', allowedFunctionNames: [tc.function.name] },
      };
    }
    Object.assign(body, req.relay?.providerOptions ?? {});
    return body;
  }

  private usage(u: any): Usage {
    if (!u) return emptyUsage();
    return {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cachedTokens: u.cachedContentTokenCount ?? 0,
      cacheWriteTokens: 0,
    };
  }

  private extract(json: any) {
    const cand = json.candidates?.[0];
    let text = '';
    const calls: ToolCall[] = [];
    for (const p of cand?.content?.parts ?? []) {
      if (p.thought) continue;
      if (typeof p.text === 'string') text += p.text;
      if (p.functionCall) calls.push({ id: `call_${Math.random().toString(36).slice(2, 12)}`, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } });
    }
    if (!cand && json.promptFeedback?.blockReason) {
      throw new ProviderError(`Prompt blocked by provider: ${json.promptFeedback.blockReason}`, 400, false, 'content_blocked');
    }
    const finish = calls.length ? 'tool_calls' : cand?.finishReason ? FINISH[cand.finishReason] ?? 'stop' : null;
    return { text, calls, finish };
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResult> {
    const url = `${this.base(ctx.provider)}/models/${encodeURIComponent(ctx.model.providerModelId)}:generateContent`;
    const json = await httpJson(url, { method: 'POST', headers: this.headers(ctx.provider), body: JSON.stringify(this.body(ctx, req)), timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    const { text, calls, finish } = this.extract(json);
    const usage = this.usage(json.usageMetadata);
    const response: ChatResponse = {
      id: json.responseId ?? chunkId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model.slug,
      choices: [{ index: 0, message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish ?? 'stop' }],
      usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
    };
    return { response, usage };
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<StreamItem> {
    const url = `${this.base(ctx.provider)}/models/${encodeURIComponent(ctx.model.providerModelId)}:streamGenerateContent?alt=sse`;
    const res = await doFetch(url, { method: 'POST', headers: this.headers(ctx.provider), body: JSON.stringify(this.body(ctx, req)), timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    if (!res.ok) throw upstreamError(res.status, await res.text());
    const id = chunkId();
    const created = Math.floor(Date.now() / 1000);
    let usage = emptyUsage();
    let first = true;
    let toolIdx = 0;
    for await (const ev of sseEvents(res)) {
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.error) throw new ProviderError(`Upstream stream error: ${json.error.message}`, 502, false, 'upstream_stream_error');
      if (json.usageMetadata) usage = this.usage(json.usageMetadata);
      const { text, calls, finish } = this.extract(json);
      const delta: any = {};
      if (first) {
        delta.role = 'assistant';
        first = false;
      }
      if (text) delta.content = text;
      if (calls.length) delta.tool_calls = calls.map((c) => ({ index: toolIdx++, ...c }));
      if (Object.keys(delta).length || finish) {
        yield { chunk: { id, object: 'chat.completion.chunk', created, model: ctx.model.slug, choices: [{ index: 0, delta, finish_reason: finish }] } };
      }
    }
    yield { usage };
  }

  async embeddings(ctx: AdapterContext, req: EmbeddingRequest): Promise<{ response: EmbeddingResponse; usage: Usage }> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const model = `models/${ctx.model.providerModelId}`;
    const json = await httpJson(`${this.base(ctx.provider)}/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: this.headers(ctx.provider),
      body: JSON.stringify({
        requests: inputs.map((text) => ({ model, content: { parts: [{ text }] }, ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}) })),
      }),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    const tokens = inputs.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    return {
      response: {
        object: 'list',
        model: ctx.model.slug,
        data: (json.embeddings ?? []).map((e: any, index: number) => ({ object: 'embedding', index, embedding: e.values })),
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      },
      usage: { inputTokens: tokens, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, estimated: true },
    };
  }

  async listModels(provider: ProviderRuntime, timeoutMs: number): Promise<string[]> {
    const json = await httpJson(`${this.base(provider)}/models?pageSize=200`, { method: 'GET', headers: this.headers(provider), timeoutMs });
    return (json.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ''));
  }
}
