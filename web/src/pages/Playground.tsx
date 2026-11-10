import { useRef, useState } from 'react';
import { Eraser, KeyRound, RefreshCw, Send, Square } from 'lucide-react';
import { Alert, Badge, Card, FormField, PageHeader, Spinner, Switch } from '../components/ui';
import { fmtUsd } from '../format';

interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  content: string;
  meta?: Meta;
}
interface Meta {
  model?: string | null;
  cost?: string | null;
  cache?: string | null;
  requestId?: string | null;
  routeDecision?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  ms?: number;
}
interface ModelEntry {
  id: string;
  owned_by: string;
  type?: string;
}

function headersMeta(res: Response): Meta {
  return {
    model: res.headers.get('x-relay-model'),
    cost: res.headers.get('x-relay-cost-usd'),
    cache: res.headers.get('x-relay-cache'),
    requestId: res.headers.get('x-relay-request-id'),
    routeDecision: res.headers.get('x-relay-route-decision'),
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const b = await res.json();
    return b?.error?.message ?? b?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status} ${res.statusText}`;
  }
}

export default function Playground() {
  // The key lives only in component state: never persisted, never sent anywhere except /v1 on this origin.
  const [key, setKey] = useState('');
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('512');
  const [stream, setStream] = useState(true);
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const scroll = () => window.requestAnimationFrame(() => chatEnd.current?.scrollIntoView({ block: 'end' }));

  const loadModels = async () => {
    setLoadingModels(true);
    setModelsErr(null);
    try {
      const res = await fetch('/v1/models', { headers: { Authorization: `Bearer ${key.trim()}` }, credentials: 'omit' });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { data: ModelEntry[] };
      const chat = body.data.filter((m) => m.type !== 'embedding');
      setModels(chat);
      if (!chat.some((m) => m.id === model)) setModel(chat[0]?.id ?? '');
    } catch (e) {
      setModels(null);
      setModelsErr((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !model || busy) return;
    const history = [...msgs.filter((m) => m.role !== 'error'), { role: 'user' as const, content: text }];
    setMsgs([...msgs, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    scroll();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const started = performance.now();
    const body: Record<string, unknown> = {
      model,
      messages: [...(system.trim() ? [{ role: 'system', content: system }] : []), ...history.map((m) => ({ role: m.role, content: m.content }))],
      stream,
    };
    if (temperature.trim() !== '') body.temperature = Number(temperature);
    if (maxTokens.trim() !== '') body.max_tokens = Number(maxTokens);
    if (stream) body.stream_options = { include_usage: true };
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit',
      });
      if (!res.ok) throw new Error(await readError(res));
      const meta = headersMeta(res);
      if (!stream || !res.body) {
        const j = await res.json();
        meta.usage = j.usage;
        meta.ms = Math.round(performance.now() - started);
        setMsgs((m) => [...m, { role: 'assistant', content: j.choices?.[0]?.message?.content ?? '', meta }]);
      } else {
        setMsgs((m) => [...m, { role: 'assistant', content: '', meta }]);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let content = '';
        let usage: Meta['usage'];
        let streamErr: string | null = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
            const event = buf.slice(0, idx);
            buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
            for (const line of event.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const j = JSON.parse(data);
                if (j.error) streamErr = j.error.message ?? 'Stream error';
                const delta = j.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') content += delta;
                if (j.usage) usage = j.usage;
              } catch {
                /* ignore partial */
              }
            }
          }
          setMsgs((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: 'assistant', content, meta: { ...meta, usage } };
            return copy;
          });
          scroll();
        }
        const ms = Math.round(performance.now() - started);
        setMsgs((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: 'assistant', content, meta: { ...meta, usage, ms } };
          if (streamErr) copy.push({ role: 'error', content: streamErr });
          return copy;
        });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') setMsgs((m) => [...m, { role: 'error', content: 'Stopped.' }]);
      else setMsgs((m) => [...m, { role: 'error', content: (e as Error).message }]);
    } finally {
      setBusy(false);
      abort.current = null;
      scroll();
    }
  };

  return (
    <>
      <PageHeader title="Playground" subtitle="Try the OpenAI-compatible /v1 API with a Relay key. Requests are metered and logged like any other client." />
      <div className="grid split">
        <div className="stack">
          <Card title="Connection">
            <FormField label="Relay API key" hint="Kept in memory for this page only; never stored.">
              <div className="input-icon">
                <KeyRound size={14} />
                <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="rly_…" value={key} onChange={(e) => setKey(e.target.value)} />
              </div>
            </FormField>
            <button className="btn mt-2" disabled={!key.trim() || loadingModels} onClick={loadModels}>
              {loadingModels ? <Spinner size={14} /> : <RefreshCw size={14} />} Load models
            </button>
            {modelsErr && (
              <div className="mt-2">
                <Alert tone="danger">{modelsErr}</Alert>
              </div>
            )}
          </Card>
          <Card title="Parameters">
            <FormField label="Model">
              <select className="select" value={model} disabled={!models} onChange={(e) => setModel(e.target.value)}>
                {!models && <option value="">Load models first</option>}
                {models?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.type === 'route' ? ' (route)' : ''}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="System prompt">
              <textarea className="textarea" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} />
            </FormField>
            <div className="form-grid">
              <FormField label="Temperature" hint="Blank = provider default">
                <input className="input" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
              </FormField>
              <FormField label="Max tokens">
                <input className="input" type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
              </FormField>
            </div>
            <div className="mt-2">
              <Switch checked={stream} onChange={setStream} label="Stream response (SSE)" />
            </div>
          </Card>
        </div>
        <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 480 }}>
          <div className="card-header">
            <h2>Chat</h2>
            <button className="btn btn-sm btn-ghost" disabled={busy || !msgs.length} onClick={() => setMsgs([])}>
              <Eraser size={13} /> Clear
            </button>
          </div>
          <div className="chat" style={{ flex: 1 }}>
            {msgs.length === 0 && <div className="muted small" style={{ margin: 'auto' }}>Paste a key, load models and send a message.</div>}
            {msgs.map((m, i) => (
              <div key={i} className={`msg msg-${m.role}`}>
                <div className="msg-role">{m.role === 'error' ? 'error' : m.role}</div>
                {m.content || (busy && i === msgs.length - 1 ? <Spinner size={13} /> : '')}
                {m.meta && (
                  <div className="row small mt-1" style={{ gap: 6, opacity: 0.85, whiteSpace: 'normal' }}>
                    {m.meta.model && <Badge>{m.meta.model}</Badge>}
                    {m.meta.cache && <Badge tone={m.meta.cache === 'HIT' ? 'success' : 'neutral'}>cache {m.meta.cache}</Badge>}
                    {m.meta.cost && <Badge tone="info">{fmtUsd(Number(m.meta.cost))}</Badge>}
                    {m.meta.usage && <span className="muted">{m.meta.usage.prompt_tokens ?? '?'} in / {m.meta.usage.completion_tokens ?? '?'} out</span>}
                    {m.meta.ms !== undefined && <span className="muted">{m.meta.ms} ms</span>}
                    {m.meta.routeDecision && <span className="muted">route: {m.meta.routeDecision}</span>}
                    {m.meta.requestId && <span className="muted mono" title="x-relay-request-id">{m.meta.requestId}</span>}
                  </div>
                )}
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          <div className="composer">
            <textarea
              className="textarea"
              rows={2}
              placeholder={model ? 'Message… (Enter to send, Shift+Enter for a new line)' : 'Load models to start'}
              value={input}
              disabled={!model}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy ? (
              <button className="btn" onClick={() => abort.current?.abort()}>
                <Square size={14} /> Stop
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!model || !input.trim()} onClick={() => void send()}>
                <Send size={14} /> Send
              </button>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
