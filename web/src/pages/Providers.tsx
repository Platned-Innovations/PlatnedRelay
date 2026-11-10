import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, Pencil, Play, Plus, Power, Search, XCircle, Zap } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import type { Provider, ProviderPreset, ProviderType } from '../types';
import { Alert, Badge, Checkbox, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge, Empty } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, Modal } from '../components/Modal';
import { JsonEditor, parseJson, validateJsonObject } from '../components/JsonEditor';
import { toast } from '../components/Toasts';
import { fmtDate, fmtRelative, numStr, optInt } from '../format';

const TYPES: { value: ProviderType; label: string }[] = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'custom', label: 'Custom HTTP (templated)' },
];

interface ProvForm {
  name: string;
  slug: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  secretHeaders: string;
  clearHeaders: boolean;
  config: string;
  timeoutMs: string;
  maxRetries: string;
  status: 'active' | 'disabled';
  importPresetModels: boolean;
}

function ProviderModal({
  open,
  provider,
  preset,
  presets,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider?: Provider;
  preset?: ProviderPreset;
  presets: ProviderPreset[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const init = (): ProvForm => ({
    name: provider?.name ?? preset?.name ?? '',
    slug: provider?.slug ?? '',
    type: provider?.type ?? preset?.type ?? 'openai',
    baseUrl: provider?.baseUrl ?? preset?.baseUrl ?? '',
    apiKey: '',
    clearApiKey: false,
    secretHeaders: '',
    clearHeaders: false,
    config: JSON.stringify(provider?.config ?? preset?.config ?? {}, null, 2),
    timeoutMs: numStr(provider?.timeoutMs),
    maxRetries: numStr(provider?.maxRetries),
    status: provider?.status ?? 'active',
    importPresetModels: true,
  });
  const [f, setF] = useState<ProvForm>(init);
  const { busy, run } = useAction();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) setF(init());
  }, [open, provider, preset]);
  const set = (p: Partial<ProvForm>) => setF((x) => ({ ...x, ...p }));
  const effPreset = preset ?? presets.find((p) => p.id === provider?.presetId);
  const customTemplate = presets.find((p) => p.id === 'custom')?.config;
  const configErr = validateJsonObject(f.config);
  const headersErr = f.secretHeaders.trim() ? validateJsonObject(f.secretHeaders, true) : null;

  const save = () =>
    run(async () => {
      const cfg = parseJson(f.config);
      const body: Record<string, unknown> = {
        name: f.name.trim(),
        type: f.type,
        baseUrl: f.baseUrl.trim(),
        config: (cfg.ok && cfg.value) || {},
        status: f.status,
      };
      const t = optInt(f.timeoutMs);
      const r = optInt(f.maxRetries);
      if (t !== undefined) body.timeoutMs = t;
      if (r !== undefined) body.maxRetries = r;
      if (provider) {
        if (f.clearApiKey) body.apiKey = '';
        else if (f.apiKey.trim()) body.apiKey = f.apiKey.trim();
        if (f.clearHeaders) body.secretHeaders = '';
        else if (f.secretHeaders.trim()) body.secretHeaders = f.secretHeaders.trim();
        if (f.slug.trim() && f.slug.trim() !== provider.slug) body.slug = f.slug.trim();
        await api.patch(`/api/admin/providers/${provider.id}`, body);
      } else {
        if (f.slug.trim()) body.slug = f.slug.trim();
        if (preset) body.presetId = preset.id;
        if (f.apiKey.trim()) body.apiKey = f.apiKey.trim();
        if (f.secretHeaders.trim()) body.secretHeaders = f.secretHeaders.trim();
        body.importPresetModels = !!preset?.models.length && f.importPresetModels;
        await api.post('/api/admin/providers', body);
      }
      onSaved();
      onClose();
    }, provider ? 'Provider updated' : 'Provider added');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={provider ? `Edit provider: ${provider.name}` : `Add provider${preset ? `: ${preset.name}` : ''}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !f.name.trim() || !f.baseUrl.trim() || !!configErr || !!headersErr} onClick={save}>
            {busy && <Spinner size={14} />} {provider ? 'Save changes' : 'Add provider'}
          </button>
        </>
      }
    >
      {effPreset && (effPreset.configHints?.length || effPreset.docsUrl) && (
        <div className="mb-2">
          <Alert tone="info" title={`${effPreset.name} notes`}>
            {effPreset.configHints?.length ? (
              <ul>
                {effPreset.configHints.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            ) : null}
            {effPreset.docsUrl && (
              <a href={effPreset.docsUrl} target="_blank" rel="noreferrer noopener">
                Provider pricing / docs <ExternalLink size={11} />
              </a>
            )}
          </Alert>
        </div>
      )}
      <div className="form-grid">
        <FormField label="Name" required>
          <input className="input" value={f.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <FormField label="Slug" hint={provider ? 'Changing the slug does not rename existing model slugs.' : 'Optional; derived from the name. Prefixes model slugs.'}>
          <input className="input mono" value={f.slug} maxLength={60} onChange={(e) => set({ slug: e.target.value })} placeholder="auto" />
        </FormField>
        <FormField label="Type">
          <select className="select" value={f.type} onChange={(e) => set({ type: e.target.value as ProviderType })}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Status">
          <select className="select" value={f.status} onChange={(e) => set({ status: e.target.value as ProvForm['status'] })}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </FormField>
        <FormField label="Base URL" required className="span-2">
          <input className="input mono" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
        </FormField>
        <FormField
          label="API key"
          className="span-2"
          hint={
            provider
              ? provider.hasApiKey
                ? `Stored (${provider.apiKeyHint}). Leave blank to keep the current key.`
                : 'No key stored.'
              : effPreset && !effPreset.needsApiKey
                ? 'Usually not required for this provider.'
                : 'Encrypted at rest; never shown again.'
          }
        >
          <input className="input mono" type="password" autoComplete="new-password" value={f.apiKey} disabled={f.clearApiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={provider?.hasApiKey ? 'unchanged' : ''} />
          {provider?.hasApiKey && <Checkbox checked={f.clearApiKey} onChange={(v) => set({ clearApiKey: v, apiKey: '' })} label="Remove the stored API key" />}
        </FormField>
        <FormField label="Timeout (ms)" hint="Blank = gateway default">
          <input className="input" type="number" min={1000} max={900000} value={f.timeoutMs} onChange={(e) => set({ timeoutMs: e.target.value })} />
        </FormField>
        <FormField label="Max retries" hint="0-5; blank = gateway default">
          <input className="input" type="number" min={0} max={5} value={f.maxRetries} onChange={(e) => set({ maxRetries: e.target.value })} />
        </FormField>
      </div>

      <div className="section-title mt-3">Configuration (JSON)</div>
      <JsonEditor value={f.config} onChange={(v) => set({ config: v })} rows={f.type === 'custom' ? 14 : 6} />
      {f.type === 'custom' && (
        <div className="mt-2">
          <div className="row between">
            <span className="hint">
              The custom adapter maps OpenAI-style requests through <code>config.custom</code>: path, method, headers, bodyTemplate (with <code>{'{{model}}'}</code>, <code>{'{{messages}}'}</code>, <code>{'{{apiKey}}'}</code>…) and responseMapping (dot paths).
            </span>
            {customTemplate && (
              <button type="button" className="btn btn-sm" onClick={() => set({ config: JSON.stringify(customTemplate, null, 2) })}>
                Insert template
              </button>
            )}
          </div>
          {customTemplate && <pre className="mt-1">{JSON.stringify(customTemplate, null, 2)}</pre>}
        </div>
      )}

      <div className="section-title mt-3">Secret headers (optional)</div>
      <p className="hint">
        JSON object of extra headers sent upstream, encrypted at rest, e.g. <code>{'{"X-Tenant-Token": "..."}'}</code>.
        {provider?.hasSecretHeaders ? ' Headers are stored; leave blank to keep them.' : ''}
      </p>
      <JsonEditor value={f.secretHeaders} onChange={(v) => set({ secretHeaders: v })} rows={3} stringValues disabled={f.clearHeaders} placeholder={provider?.hasSecretHeaders ? 'unchanged' : '{}'} />
      {provider?.hasSecretHeaders && <Checkbox checked={f.clearHeaders} onChange={(v) => set({ clearHeaders: v, secretHeaders: '' })} label="Remove stored secret headers" />}

      {!provider && !!preset?.models.length && (
        <div className="mt-3">
          <Checkbox checked={f.importPresetModels} onChange={(v) => set({ importPresetModels: v })} label={`Import ${preset.models.length} preset models with default pricing`} />
          <div className="hint">Preset prices are defaults captured at build time - verify them in Models & Pricing.</div>
        </div>
      )}
    </Modal>
  );
}

function PresetPicker({ open, presets, onPick, onClose }: { open: boolean; presets: ProviderPreset[]; onPick: (p: ProviderPreset) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = presets.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.type.includes(q.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Add provider - choose a template">
      <div className="input-icon mb-2" style={{ maxWidth: 320 }}>
        <Search size={14} />
        <input className="input" placeholder="Filter templates…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="preset-grid">
        {list.map((p) => (
          <button key={p.id} className="preset" onClick={() => onPick(p)}>
            <div className="cell-title">{p.name}</div>
            <div className="cell-sub mono">{p.baseUrl}</div>
            <div className="row mt-1" style={{ gap: 4 }}>
              <Badge>{p.type}</Badge>
              {p.models.length > 0 && <Badge tone="info">{p.models.length} models</Badge>}
              {!p.needsApiKey && <Badge>no key</Badge>}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function DiscoverModal({ provider, onClose, onAdded }: { provider: Provider | null; onClose: () => void; onAdded: () => void }) {
  const { data, error, loading, reload } = useApi<{ available: string[]; existing: string[] }>(provider ? `/api/admin/providers/${provider.id}/discover` : null);
  const [added, setAdded] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const { busy, run } = useAction();
  useEffect(() => setAdded([]), [provider]);
  if (!provider) return null;
  const existing = new Set([...(data?.existing ?? []), ...added]);
  const list = (data?.available ?? []).filter((id) => !q || id.toLowerCase().includes(q.toLowerCase()));
  const add = (id: string) =>
    run(async () => {
      await api.post('/api/admin/models', { providerId: provider.id, providerModelId: id, displayName: id, pricing: { input: 0, output: 0 } });
      setAdded((a) => [...a, id]);
      onAdded();
      toast.info(`Added ${id} with $0 pricing - set real prices in Models & Pricing.`);
    });
  return (
    <Modal open onClose={onClose} size="lg" title={`Discover models: ${provider.name}`}>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <Loading label="Querying upstream model list…" />
      ) : !data?.available.length ? (
        <Empty title="No models discovered">This provider type does not support listing models, or the upstream returned none. Add models manually in Models & Pricing.</Empty>
      ) : (
        <>
          <div className="row between mb-2">
            <div className="input-icon" style={{ width: 280 }}>
              <Search size={14} />
              <input className="input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <span className="muted small">
              {data.available.length} available · {data.existing.length} already configured
            </span>
          </div>
          <div className="card" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="table table-compact">
              <tbody>
                {list.map((id) => (
                  <tr key={id}>
                    <td className="mono">{id}</td>
                    <td className="actions">
                      {existing.has(id) ? (
                        <Badge tone="success">configured</Badge>
                      ) : (
                        <button className="btn btn-sm" disabled={busy} onClick={() => add(id)}>
                          <Plus size={13} /> Add as model
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint mt-1">Models added here start with $0 pricing so costs will be under-reported until you set prices.</p>
        </>
      )}
    </Modal>
  );
}

export default function Providers() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<Provider[]>('/api/admin/providers');
  const presets = useApi<ProviderPreset[]>('/api/admin/providers/presets', { cached: true });
  const [picking, setPicking] = useState(false);
  const [modal, setModal] = useState<{ provider?: Provider; preset?: ProviderPreset } | null>(null);
  const [discover, setDiscover] = useState<Provider | null>(null);
  const [toggle, setToggle] = useState<Provider | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const { run } = useAction();

  const test = (p: Provider) => {
    setTesting(p.id);
    void run(async () => {
      const r = await api.post<{ ok: boolean; message: string; latencyMs: number }>(`/api/admin/providers/${p.id}/test`);
      if (r.ok) toast.success(`${p.name}: ${r.message} (${r.latencyMs} ms)`);
      else toast.error(new Error(`${p.name}: ${r.message}`));
      reload();
    }).finally(() => setTesting(null));
  };
  const importPreset = (p: Provider) =>
    run(async () => {
      const r = await api.post<{ imported: number }>(`/api/admin/providers/${p.id}/import-preset-models`);
      toast.success(r.imported ? `Imported ${r.imported} preset models` : 'All preset models already exist');
      reload();
    });

  const presetIdsWithModels = useMemo(() => new Set((presets.data ?? []).filter((p) => p.models.length).map((p) => p.id)), [presets.data]);

  const columns: Column<Provider>[] = [
    { key: 'name', header: 'Provider', render: (p) => <div><div className="cell-title">{p.name}</div><div className="cell-sub mono">{p.slug}</div></div> },
    { key: 'type', header: 'Type', render: (p) => <Badge>{p.type}</Badge> },
    { key: 'baseUrl', header: 'Base URL', hideSm: true, render: (p) => <span className="mono small truncate" title={p.baseUrl}>{p.baseUrl}</span> },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'modelCount', header: 'Models', numeric: true },
    { key: 'apiKeyHint', header: 'API key', hideSm: true, render: (p) => (p.hasApiKey ? <span className="mono small">{p.apiKeyHint}</span> : <span className="muted">none</span>) },
    {
      key: 'lastTestAt',
      header: 'Last test',
      render: (p) =>
        p.lastTestAt ? (
          <span title={`${fmtDate(p.lastTestAt)}\n${p.lastTestMessage ?? ''}`} className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            {p.lastTestOk ? <CheckCircle2 size={14} className="success-text" /> : <XCircle size={14} className="danger-text" />}
            <span className="small">{fmtRelative(p.lastTestAt)}</span>
          </span>
        ) : (
          <span className="muted">never</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (p) =>
        canEdit && (
          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
            <button className="btn btn-sm" onClick={() => test(p)} disabled={testing === p.id} title="Test connection">
              {testing === p.id ? <Spinner size={13} /> : <Play size={13} />} Test
            </button>
            <button className="btn btn-sm" onClick={() => setDiscover(p)} title="Discover upstream models">
              <Zap size={13} /> Discover
            </button>
            {p.presetId && presetIdsWithModels.has(p.presetId) && (
              <button className="btn btn-sm" onClick={() => importPreset(p)} title="Import preset models">
                <Download size={13} />
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setModal({ provider: p })} title="Edit">
              <Pencil size={13} />
            </button>
            <button className="btn btn-sm" onClick={() => setToggle(p)} title={p.status === 'active' ? 'Disable' : 'Enable'}>
              <Power size={13} />
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle="Upstream LLM APIs. Credentials are encrypted with the master key and never returned in full."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setPicking(true)}>
              <Plus size={15} /> Add provider
            </button>
          )
        }
      />
      <div className="card">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={data ?? []} rowKey={(p) => p.id} emptyTitle="No providers" emptyText="Add a provider from a template to get started." initialSort={{ key: 'name', dir: 'asc' }} />}
      </div>
      <PresetPicker
        open={picking}
        presets={presets.data ?? []}
        onClose={() => setPicking(false)}
        onPick={(p) => {
          setPicking(false);
          setModal({ preset: p });
        }}
      />
      <ProviderModal open={!!modal} provider={modal?.provider} preset={modal?.preset} presets={presets.data ?? []} onClose={() => setModal(null)} onSaved={reload} />
      <DiscoverModal provider={discover} onClose={() => setDiscover(null)} onAdded={reload} />
      <ConfirmDialog
        open={!!toggle}
        title={toggle?.status === 'active' ? `Disable ${toggle?.name}?` : `Enable ${toggle?.name}?`}
        message={toggle?.status === 'active' ? 'Requests to this provider’s models fail over to other route targets or are rejected.' : 'The provider will receive traffic again.'}
        confirmLabel={toggle?.status === 'active' ? 'Disable' : 'Enable'}
        danger={toggle?.status === 'active'}
        onConfirm={async () => {
          await api.patch(`/api/admin/providers/${toggle!.id}`, { status: toggle!.status === 'active' ? 'disabled' : 'active' });
          toast.success('Provider updated');
          reload();
        }}
        onClose={() => setToggle(null)}
      />
    </>
  );
}
