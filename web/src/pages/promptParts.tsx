import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { PromptRole, PromptTemplate } from '../types';
import { FormField } from '../components/ui';
import { numStr, optInt, optNum } from '../format';

export interface TemplateForm {
  messages: { role: PromptRole; content: string }[];
  model: string;
  temperature: string;
  max_tokens: string;
  top_p: string;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function detectVariables(messages: { content: string }[]): string[] {
  const s = new Set<string>();
  for (const m of messages) for (const x of m.content.matchAll(VAR_RE)) s.add(x[1]);
  return [...s];
}

export function templateFormFrom(t?: PromptTemplate): TemplateForm {
  return {
    messages: t?.messages?.length ? t.messages.map((m) => ({ ...m })) : [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '{{question}}' },
    ],
    model: t?.model ?? '',
    temperature: numStr(t?.params?.temperature),
    max_tokens: numStr(t?.params?.max_tokens),
    top_p: numStr(t?.params?.top_p),
  };
}

export function templatePayload(f: TemplateForm): PromptTemplate {
  const params: NonNullable<PromptTemplate['params']> = {};
  const t = optNum(f.temperature);
  const mt = optInt(f.max_tokens);
  const tp = optNum(f.top_p);
  if (t !== undefined) params.temperature = t;
  if (mt !== undefined) params.max_tokens = mt;
  if (tp !== undefined) params.top_p = tp;
  const out: PromptTemplate = { messages: f.messages };
  if (f.model.trim()) out.model = f.model.trim();
  if (Object.keys(params).length) out.params = params;
  return out;
}

const ROLES: PromptRole[] = ['system', 'developer', 'user', 'assistant'];

export function TemplateEditor({ f, set, modelOptions }: { f: TemplateForm; set: (p: Partial<TemplateForm>) => void; modelOptions: string[] }) {
  const upd = (i: number, p: Partial<TemplateForm['messages'][number]>) => set({ messages: f.messages.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const move = (i: number, d: -1 | 1) => {
    const m = [...f.messages];
    const j = i + d;
    if (j < 0 || j >= m.length) return;
    [m[i], m[j]] = [m[j], m[i]];
    set({ messages: m });
  };
  const vars = detectVariables(f.messages);
  return (
    <>
      <div className="section-title">Messages</div>
      <p className="hint">
        Use <code>{'{{variable}}'}</code> placeholders; callers supply values in <code>relay.prompt.variables</code>.
      </p>
      {f.messages.map((m, i) => (
        <div className="msg-editor" key={i}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <select className="select select-sm" style={{ width: 140 }} value={m.role} onChange={(e) => upd(i, { role: e.target.value as PromptRole })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <div className="row" style={{ gap: 2 }}>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={13} />
              </button>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Move down" disabled={i === f.messages.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={13} />
              </button>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Remove" disabled={f.messages.length <= 1} onClick={() => set({ messages: f.messages.filter((_, j) => j !== i) })}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          <textarea className="textarea mono" rows={Math.min(14, Math.max(3, m.content.split('\n').length + 1))} value={m.content} onChange={(e) => upd(i, { content: e.target.value })} />
        </div>
      ))}
      <button type="button" className="btn btn-sm mt-1" disabled={f.messages.length >= 100} onClick={() => set({ messages: [...f.messages, { role: 'user', content: '' }] })}>
        <Plus size={13} /> Add message
      </button>
      <div className="row mt-2 small">
        <span className="muted">Detected variables:</span>
        {vars.length ? vars.map((v) => <code key={v}>{v}</code>) : <span className="muted">none</span>}
      </div>

      <div className="section-title mt-3">Defaults (optional)</div>
      <div className="form-grid form-grid-4">
        <FormField label="Model" hint="Used when the caller omits model">
          <input className="input mono" list="prompt-model-opts" value={f.model} onChange={(e) => set({ model: e.target.value })} />
          <datalist id="prompt-model-opts">
            {modelOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FormField>
        <FormField label="Temperature" hint="0-2">
          <input className="input" type="number" min={0} max={2} step={0.1} value={f.temperature} onChange={(e) => set({ temperature: e.target.value })} />
        </FormField>
        <FormField label="Max tokens">
          <input className="input" type="number" min={1} value={f.max_tokens} onChange={(e) => set({ max_tokens: e.target.value })} />
        </FormField>
        <FormField label="Top P" hint="0-1">
          <input className="input" type="number" min={0} max={1} step={0.05} value={f.top_p} onChange={(e) => set({ top_p: e.target.value })} />
        </FormField>
      </div>
    </>
  );
}
