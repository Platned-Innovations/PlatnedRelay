import { useMemo, useState } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useModels, useProviders, useRoutes } from '../hooks';
import type { KeyAccess, KeyLimits } from '../types';
import { Alert, CodeBlock, CopyButton, FormField, Tabs } from '../components/ui';
import { Modal } from '../components/Modal';
import { MultiSelect } from '../components/MultiSelect';
import { numStr, optInt } from '../format';

export interface AccessForm {
  mode: 'all' | 'restricted';
  providerIds: string[];
  modelIds: string[];
  routeIds: string[];
  rpm: string;
  tpm: string;
  maxTokensPerRequest: string;
  maxConcurrent: string;
  ipAllowlist: string;
  metadata: { k: string; v: string }[];
}

export function accessFormFrom(a?: { access?: KeyAccess; limits?: KeyLimits; ipAllowlist?: string[]; metadata?: Record<string, unknown> }): AccessForm {
  return {
    mode: a?.access?.mode ?? 'all',
    providerIds: a?.access?.providerIds ?? [],
    modelIds: a?.access?.modelIds ?? [],
    routeIds: a?.access?.routeIds ?? [],
    rpm: numStr(a?.limits?.rpm),
    tpm: numStr(a?.limits?.tpm),
    maxTokensPerRequest: numStr(a?.limits?.maxTokensPerRequest),
    maxConcurrent: numStr(a?.limits?.maxConcurrent),
    ipAllowlist: (a?.ipAllowlist ?? []).join('\n'),
    metadata: Object.entries(a?.metadata ?? {}).map(([k, v]) => ({ k, v: String(v) })),
  };
}

export function accessPayload(f: AccessForm) {
  const limits: KeyLimits = {};
  const rpm = optInt(f.rpm);
  const tpm = optInt(f.tpm);
  const mtp = optInt(f.maxTokensPerRequest);
  const mc = optInt(f.maxConcurrent);
  if (rpm !== undefined) limits.rpm = rpm;
  if (tpm !== undefined) limits.tpm = tpm;
  if (mtp !== undefined) limits.maxTokensPerRequest = mtp;
  if (mc !== undefined) limits.maxConcurrent = mc;
  const metadata: Record<string, string> = {};
  for (const { k, v } of f.metadata) if (k.trim()) metadata[k.trim()] = v;
  return {
    access: f.mode === 'all' ? { mode: 'all' as const, providerIds: [], modelIds: [], routeIds: [] } : { mode: 'restricted' as const, providerIds: f.providerIds, modelIds: f.modelIds, routeIds: f.routeIds },
    limits,
    ipAllowlist: f.ipAllowlist
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    metadata,
  };
}

/** Access mode + limits + IP allowlist + metadata editor shared by create and edit. */
export function AccessEditor({ f, set }: { f: AccessForm; set: (patch: Partial<AccessForm>) => void }) {
  const providers = useProviders();
  const models = useModels();
  const routes = useRoutes();
  const modelOpts = useMemo(() => (models.data ?? []).map((m) => ({ value: m.id, label: m.slug, hint: m.providerName })), [models.data]);
  return (
    <>
      <div className="section-title">Access</div>
      <div className="btn-group" role="radiogroup">
        <button type="button" className={`btn btn-sm${f.mode === 'all' ? ' active' : ''}`} onClick={() => set({ mode: 'all' })}>
          All models & routes
        </button>
        <button type="button" className={`btn btn-sm${f.mode === 'restricted' ? ' active' : ''}`} onClick={() => set({ mode: 'restricted' })}>
          Restricted
        </button>
      </div>
      <div className="hint mt-1">
        {f.mode === 'all'
          ? 'The key can call any active model or route allowed for its app.'
          : 'The key can only call the selected routes, the selected models, and any model of the selected providers.'}
      </div>
      {f.mode === 'restricted' && (
        <div className="form-grid form-grid-3 mt-2">
          <FormField label="Providers" hint="All models of these providers">
            <MultiSelect options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))} value={f.providerIds} onChange={(v) => set({ providerIds: v })} height={150} />
          </FormField>
          <FormField label="Models">
            <MultiSelect options={modelOpts} value={f.modelIds} onChange={(v) => set({ modelIds: v })} height={150} />
          </FormField>
          <FormField label="Routes">
            <MultiSelect options={(routes.data ?? []).map((r) => ({ value: r.id, label: r.slug, hint: r.strategy }))} value={f.routeIds} onChange={(v) => set({ routeIds: v })} height={150} />
          </FormField>
        </div>
      )}

      <div className="section-title mt-3">Limits</div>
      <div className="form-grid form-grid-4">
        <FormField label="Requests / min" hint="Blank = gateway default">
          <input className="input" type="number" min={0} value={f.rpm} onChange={(e) => set({ rpm: e.target.value })} />
        </FormField>
        <FormField label="Tokens / min" hint="Blank = unlimited">
          <input className="input" type="number" min={0} value={f.tpm} onChange={(e) => set({ tpm: e.target.value })} />
        </FormField>
        <FormField label="Max tokens / request">
          <input className="input" type="number" min={0} value={f.maxTokensPerRequest} onChange={(e) => set({ maxTokensPerRequest: e.target.value })} />
        </FormField>
        <FormField label="Max concurrent">
          <input className="input" type="number" min={0} value={f.maxConcurrent} onChange={(e) => set({ maxConcurrent: e.target.value })} />
        </FormField>
      </div>

      <div className="form-grid mt-2">
        <FormField label="IP allowlist" hint="One IP or CIDR per line. Empty = any IP.">
          <textarea className="textarea mono" rows={4} value={f.ipAllowlist} onChange={(e) => set({ ipAllowlist: e.target.value })} placeholder={'10.0.0.0/8\n203.0.113.7'} />
        </FormField>
        <FormField label="Metadata" hint="Free-form key/values stored with the key.">
          <div className="list-rows">
            {f.metadata.map((m, i) => (
              <div className="editor-row" key={i}>
                <input className="input input-sm" placeholder="key" value={m.k} onChange={(e) => set({ metadata: f.metadata.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })} />
                <input className="input input-sm" placeholder="value" value={m.v} maxLength={500} onChange={(e) => set({ metadata: f.metadata.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) })} />
                <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Remove" onClick={() => set({ metadata: f.metadata.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => set({ metadata: [...f.metadata, { k: '', v: '' }] })}>
              <Plus size={13} /> Add field
            </button>
          </div>
        </FormField>
      </div>
    </>
  );
}

function snippets(secret: string, model: string) {
  const base = `${window.location.origin}/v1`;
  return {
    curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello from Relay"}]
  }'`,
    python: `# pip install openai
from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${secret}",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello from Relay"}],
)
print(resp.choices[0].message.content)`,
    js: `// npm install openai
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${base}',
  apiKey: process.env.RELAY_API_KEY ?? '${secret}',
});

const resp = await client.chat.completions.create({
  model: '${model}',
  messages: [{ role: 'user', content: 'Hello from Relay' }],
});
console.log(resp.choices[0].message.content);`,
  };
}

/** Shows a newly issued secret exactly once. */
export function SecretModal({ secret, keyName, onClose }: { secret: string | null; keyName?: string; onClose: () => void }) {
  const models = useModels();
  const routes = useRoutes();
  const [tab, setTab] = useState<'curl' | 'python' | 'js'>('curl');
  const [ack, setAck] = useState(false);
  const model = models.data?.find((m) => m.status === 'active' && m.type === 'chat')?.slug ?? routes.data?.[0]?.slug ?? 'MODEL_SLUG';
  if (!secret) return null;
  const s = snippets(secret, model);
  return (
    <Modal
      open
      dismissible={false}
      onClose={() => ack && onClose()}
      title={`API key secret${keyName ? `: ${keyName}` : ''}`}
      size="lg"
      footer={
        <>
          <label className="check left">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have copied and stored the secret securely
          </label>
          <button className="btn btn-primary" disabled={!ack} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <Alert tone="warning" title="Copy this secret now - it will never be shown again">
        Relay stores only a keyed hash of the secret. If it is lost you must regenerate the key. Treat it like a password: never commit it to source control or share it in chat.
      </Alert>
      <div className="secret-box mt-2">
        <AlertTriangle size={16} style={{ color: 'var(--warning)', flex: '0 0 auto' }} />
        <span>{secret}</span>
        <CopyButton text={secret} label="Copy" />
      </div>
      <div className="section-title mt-3">Use it</div>
      <p className="small muted">
        Relay is OpenAI-compatible. Base URL: <code>{window.location.origin}/v1</code>
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'curl', label: 'curl' },
          { id: 'python', label: 'Python (OpenAI SDK)' },
          { id: 'js', label: 'JavaScript (OpenAI SDK)' },
        ]}
      />
      <CodeBlock code={s[tab]} />
    </Modal>
  );
}
