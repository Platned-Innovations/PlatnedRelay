import { useEffect, useMemo, useState } from 'react';
import { History, Pencil, Plus, Search } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useProviders } from '../hooks';
import type { Capabilities, Model, PricingHistoryRow, Tier } from '../types';
import { Alert, Badge, Checkbox, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge, Empty } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer, Modal } from '../components/Modal';
import { fmtDate, fmtPrice, fmtTokens, numStr, optInt, optNum } from '../format';

const CAPS: (keyof Capabilities)[] = ['vision', 'tools', 'streaming', 'json', 'sampling', 'reasoning'];
const CAP_HINTS: Record<keyof Capabilities, string> = {
  vision: 'Image inputs',
  tools: 'Function / tool calling',
  streaming: 'SSE streaming',
  json: 'JSON mode / structured output',
  sampling: 'Accepts temperature/top_p',
  reasoning: 'Reasoning model',
};

interface ModelForm {
  providerId: string;
  providerModelId: string;
  slug: string;
  displayName: string;
  type: 'chat' | 'embedding';
  tier: Tier;
  status: 'active' | 'disabled';
  contextWindow: string;
  maxOutputTokens: string;
  input: string;
  output: string;
  cachedInput: string;
  cacheWrite: string;
  perRequest: string;
  capabilities: Capabilities;
  notes: string;
}

function ModelModal({ open, model, onClose, onSaved }: { open: boolean; model?: Model; onClose: () => void; onSaved: () => void }) {
  const providers = useProviders();
  const init = (): ModelForm => ({
    providerId: model?.providerId ?? '',
    providerModelId: model?.providerModelId ?? '',
    slug: model?.slug ?? '',
    displayName: model?.displayName ?? '',
    type: model?.type ?? 'chat',
    tier: model?.tier ?? 'standard',
    status: model?.status ?? 'active',
    contextWindow: numStr(model?.contextWindow),
    maxOutputTokens: numStr(model?.maxOutputTokens),
    input: numStr(model?.pricing.input ?? 0),
    output: numStr(model?.pricing.output ?? 0),
    cachedInput: numStr(model?.pricing.cachedInput),
    cacheWrite: numStr(model?.pricing.cacheWrite),
    perRequest: numStr(model?.pricing.perRequest),
    capabilities: model?.capabilities ?? { tools: true, streaming: true, sampling: true },
    notes: model?.notes ?? '',
  });
  const [f, setF] = useState<ModelForm>(init);
  const { busy, run } = useAction();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) setF(init());
  }, [open, model]);
  const set = (p: Partial<ModelForm>) => setF((x) => ({ ...x, ...p }));
  const prov = providers.data?.find((p) => p.id === f.providerId);
  const valid = f.providerId && f.providerModelId.trim() && f.displayName.trim() && optNum(f.input) !== undefined && optNum(f.output) !== undefined;

  const save = () =>
    run(async () => {
      const pricing: Record<string, number> = { input: optNum(f.input) ?? 0, output: optNum(f.output) ?? 0 };
      for (const k of ['cachedInput', 'cacheWrite', 'perRequest'] as const) {
        const v = optNum(f[k]);
        if (v !== undefined) pricing[k] = v;
      }
      const body: Record<string, unknown> = {
        providerModelId: f.providerModelId.trim(),
        displayName: f.displayName.trim(),
        type: f.type,
        tier: f.tier,
        status: f.status,
        pricing,
        capabilities: Object.fromEntries(CAPS.map((c) => [c, !!f.capabilities[c]])),
        notes: f.notes,
      };
      const cw = optInt(f.contextWindow);
      const mo = optInt(f.maxOutputTokens);
      if (cw) body.contextWindow = cw;
      if (mo) body.maxOutputTokens = mo;
      if (f.slug.trim()) body.slug = f.slug.trim();
      if (model) await api.patch(`/api/admin/models/${model.id}`, body);
      else await api.post('/api/admin/models', { ...body, providerId: f.providerId });
      onSaved();
      onClose();
    }, model ? 'Model updated' : 'Model created');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={model ? `Edit model: ${model.slug}` : 'New model'}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !valid} onClick={save}>
            {busy && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Provider" required hint={model ? 'Cannot be changed' : undefined}>
          <select className="select" value={f.providerId} disabled={!!model} onChange={(e) => set({ providerId: e.target.value })}>
            <option value="">Select…</option>
            {(providers.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Upstream model ID" required hint="Exactly as the provider expects it (Azure: deployment name)">
          <input className="input mono" value={f.providerModelId} onChange={(e) => set({ providerModelId: e.target.value })} />
        </FormField>
        <FormField label="Display name" required>
          <input className="input" value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} />
        </FormField>
        <FormField label="Slug" hint={`What clients send as "model". Default: ${prov?.slug ?? '<provider>'}/${f.providerModelId || '<model>'}`}>
          <input className="input mono" value={f.slug} onChange={(e) => set({ slug: e.target.value })} placeholder="auto" />
        </FormField>
        <FormField label="Type">
          <select className="select" value={f.type} onChange={(e) => set({ type: e.target.value as ModelForm['type'] })}>
            <option value="chat">Chat</option>
            <option value="embedding">Embedding</option>
          </select>
        </FormField>
        <FormField label="Tier" hint="Used by auto/cheapest routing">
          <select className="select" value={f.tier} onChange={(e) => set({ tier: e.target.value as Tier })}>
            <option value="cheap">Cheap</option>
            <option value="standard">Standard</option>
            <option value="strong">Strong</option>
          </select>
        </FormField>
        <FormField label="Context window (tokens)">
          <input className="input" type="number" min={1} value={f.contextWindow} onChange={(e) => set({ contextWindow: e.target.value })} />
        </FormField>
        <FormField label="Max output tokens">
          <input className="input" type="number" min={1} value={f.maxOutputTokens} onChange={(e) => set({ maxOutputTokens: e.target.value })} />
        </FormField>
        <FormField label="Status">
          <select className="select" value={f.status} onChange={(e) => set({ status: e.target.value as ModelForm['status'] })}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </FormField>
      </div>

      <div className="section-title mt-3">Pricing (USD per 1M tokens)</div>
      <div className="form-grid form-grid-3">
        <FormField label="Input" required>
          <input className="input" type="number" min={0} step="any" value={f.input} onChange={(e) => set({ input: e.target.value })} />
        </FormField>
        <FormField label="Output" required>
          <input className="input" type="number" min={0} step="any" value={f.output} onChange={(e) => set({ output: e.target.value })} />
        </FormField>
        <FormField label="Cached input (read)">
          <input className="input" type="number" min={0} step="any" value={f.cachedInput} onChange={(e) => set({ cachedInput: e.target.value })} />
        </FormField>
        <FormField label="Cache write">
          <input className="input" type="number" min={0} step="any" value={f.cacheWrite} onChange={(e) => set({ cacheWrite: e.target.value })} />
        </FormField>
        <FormField label="Per request (flat USD)">
          <input className="input" type="number" min={0} step="any" value={f.perRequest} onChange={(e) => set({ perRequest: e.target.value })} />
        </FormField>
      </div>
      {model && <p className="hint mt-1">Price changes are versioned in the pricing history and apply to new requests only.</p>}

      <div className="section-title mt-3">Capabilities</div>
      <div className="check-grid">
        {CAPS.map((c) => (
          <Checkbox key={c} checked={!!f.capabilities[c]} onChange={(v) => set({ capabilities: { ...f.capabilities, [c]: v } })} label={<span title={CAP_HINTS[c]}>{c}</span>} />
        ))}
      </div>
      <FormField label="Notes" className="mt-2">
        <textarea className="textarea" rows={2} value={f.notes} maxLength={2000} onChange={(e) => set({ notes: e.target.value })} />
      </FormField>
    </Modal>
  );
}

function PricingHistory({ model, onClose }: { model: Model | null; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<PricingHistoryRow[]>(model ? `/api/admin/models/${model.id}/pricing-history` : null);
  if (!model) return null;
  const p = (x?: number) => (x === undefined ? '-' : fmtPrice(x));
  return (
    <Drawer open title={`Pricing history: ${model.slug}`} onClose={onClose} wide>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading || !data ? (
        <Loading />
      ) : !data.length ? (
        <Empty title="No pricing history" />
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Changed</th>
              <th>By</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cached</th>
              <th className="num">Cache write</th>
              <th className="num">Per req</th>
            </tr>
          </thead>
          <tbody>
            {data.map((h) => (
              <tr key={h.id}>
                <td className="nowrap">{fmtDate(h.createdAt)}</td>
                <td>{h.changedBy ?? '-'}</td>
                {(['input', 'output', 'cachedInput', 'cacheWrite', 'perRequest'] as const).map((k) => (
                  <td key={k} className="num" title={h.previous ? `was ${p(h.previous[k])}` : 'initial'}>
                    {p(h.pricing[k])}
                    {h.previous && h.previous[k] !== h.pricing[k] && <div className="cell-sub">was {p(h.previous[k])}</div>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}

export default function Models() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<Model[]>('/api/admin/models');
  const providers = useProviders();
  const [providerId, setProviderId] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ model?: Model } | null>(null);
  const [hist, setHist] = useState<Model | null>(null);

  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (m) => (!providerId || m.providerId === providerId) && (!type || m.type === type) && (!q || m.slug.includes(q.toLowerCase()) || m.displayName.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, providerId, type, q],
  );

  const columns: Column<Model>[] = [
    { key: 'slug', header: 'Model', render: (m) => <div><div className="cell-title mono">{m.slug}</div><div className="cell-sub">{m.displayName}</div></div> },
    { key: 'providerName', header: 'Provider' },
    { key: 'type', header: 'Type', render: (m) => <Badge>{m.type}</Badge> },
    { key: 'tier', header: 'Tier', render: (m) => (m.tier ? <Badge tone={m.tier === 'strong' ? 'info' : 'neutral'}>{m.tier}</Badge> : '-') },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
    { key: 'input', header: 'Input / 1M', numeric: true, render: (m) => fmtPrice(m.pricing.input), sortValue: (m) => m.pricing.input },
    { key: 'output', header: 'Output / 1M', numeric: true, render: (m) => fmtPrice(m.pricing.output), sortValue: (m) => m.pricing.output },
    { key: 'cachedInput', header: 'Cached / 1M', numeric: true, hideSm: true, render: (m) => fmtPrice(m.pricing.cachedInput), sortValue: (m) => m.pricing.cachedInput },
    { key: 'cacheWrite', header: 'Cache write / 1M', numeric: true, hideSm: true, render: (m) => fmtPrice(m.pricing.cacheWrite), sortValue: (m) => m.pricing.cacheWrite },
    { key: 'contextWindow', header: 'Context', numeric: true, hideSm: true, render: (m) => fmtTokens(m.contextWindow) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (m) => (
        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
          <button className="btn btn-sm" title="Pricing history" onClick={() => setHist(m)}>
            <History size={13} />
          </button>
          {canEdit && (
            <button className="btn btn-sm" onClick={() => setEdit({ model: m })}>
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Models & pricing"
        subtitle="Models clients can call by slug, with per-1M-token prices used for cost metering."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setEdit({})}>
              <Plus size={15} /> New model
            </button>
          )
        }
      />
      <div className="mb-2">
        <Alert tone="warning" title="Verify seeded prices">
          Prices imported from provider templates are defaults captured when Relay was built. Check them against each provider’s current pricing page - cost reports and spend caps depend on them.
        </Alert>
      </div>
      <div className="toolbar">
        <div className="input-icon search">
          <Search size={14} />
          <input className="input" placeholder="Search slug or name…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 180 }} value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider">
          <option value="">All providers</option>
          {(providers.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 140 }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          <option value="chat">Chat</option>
          <option value="embedding">Embedding</option>
        </select>
      </div>
      <div className="card">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Loading />
        ) : (
          <DataTable columns={columns} rows={rows} rowKey={(m) => m.id} emptyTitle="No models" initialSort={{ key: 'providerName', dir: 'asc' }} compact />
        )}
      </div>
      <ModelModal open={!!edit} model={edit?.model} onClose={() => setEdit(null)} onSaved={reload} />
      <PricingHistory model={hist} onClose={() => setHist(null)} />
    </>
  );
}
