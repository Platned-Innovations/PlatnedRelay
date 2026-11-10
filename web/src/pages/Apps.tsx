import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Search } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useGuardrails, useModels, useRoutes } from '../hooks';
import type { App } from '../types';
import { Badge, Checkbox, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { MultiSelect } from '../components/MultiSelect';
import { fmtDate, numStr, optInt, splitList } from '../format';

interface AppForm {
  name: string;
  description: string;
  owner: string;
  ownerEmail: string;
  status: 'active' | 'disabled';
  tags: string;
  cacheEnabled: boolean;
  cacheTtlSeconds: string;
  logBodies: 'inherit' | 'on' | 'off';
  guardrailPolicyIds: string[];
  allowedModelIds: string[];
  defaultModel: string;
  rpm: string;
}

function toForm(a?: App): AppForm {
  const s = a?.settings ?? {};
  return {
    name: a?.name ?? '',
    description: a?.description ?? '',
    owner: a?.owner ?? '',
    ownerEmail: a?.ownerEmail ?? '',
    status: a?.status ?? 'active',
    tags: (a?.tags ?? []).join(', '),
    cacheEnabled: !!s.cacheEnabled,
    cacheTtlSeconds: numStr(s.cacheTtlSeconds),
    logBodies: s.logBodies === undefined ? 'inherit' : s.logBodies ? 'on' : 'off',
    guardrailPolicyIds: s.guardrailPolicyIds ?? [],
    allowedModelIds: s.allowedModelIds ?? [],
    defaultModel: s.defaultModel ?? '',
    rpm: numStr(s.rpm),
  };
}

function AppModal({ app, open, onClose, onSaved }: { app?: App; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<AppForm>(toForm(app));
  const models = useModels();
  const guardrails = useGuardrails();
  const routes = useRoutes();
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) setF(toForm(app));
  }, [open, app]);
  const set = <K extends keyof AppForm>(k: K, v: AppForm[K]) => setF((p) => ({ ...p, [k]: v }));

  const save = () =>
    run(async () => {
      const settings: Record<string, unknown> = {
        cacheEnabled: f.cacheEnabled,
        guardrailPolicyIds: f.guardrailPolicyIds,
        allowedModelIds: f.allowedModelIds,
        // null clears the value so the app inherits the gateway default again
        defaultModel: f.defaultModel.trim() || null,
        rpm: optInt(f.rpm) ?? null,
        logBodies: f.logBodies === 'inherit' ? null : f.logBodies === 'on',
        cacheTtlSeconds: optInt(f.cacheTtlSeconds) ?? null,
      };
      const body = {
        name: f.name.trim(),
        description: f.description.trim(),
        owner: f.owner.trim(),
        ownerEmail: f.ownerEmail.trim(),
        status: f.status,
        tags: splitList(f.tags),
        settings,
      };
      if (app) await api.patch(`/api/admin/apps/${app.id}`, body);
      else await api.post('/api/admin/apps', body);
      onSaved();
      onClose();
    }, app ? 'App updated' : 'App created');

  const modelOptions = useMemo(() => (models.data ?? []).map((m) => ({ value: m.id, label: m.slug, hint: m.providerName })), [models.data]);
  const defaultModelOptions = useMemo(() => [...(models.data ?? []).map((m) => m.slug), ...(routes.data ?? []).map((r) => r.slug)], [models.data, routes.data]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={app ? `Edit app: ${app.name}` : 'New app'}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !f.name.trim()}>
            {busy && <Spinner size={14} />} {app ? 'Save changes' : 'Create app'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Name" required>
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={100} />
        </FormField>
        <FormField label="Status">
          <select className="select" value={f.status} onChange={(e) => set('status', e.target.value as AppForm['status'])}>
            <option value="active">Active</option>
            <option value="disabled">Disabled (all keys rejected)</option>
          </select>
        </FormField>
        <FormField label="Description" className="span-2">
          <textarea className="textarea" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
        </FormField>
        <FormField label="Owner">
          <input className="input" value={f.owner} onChange={(e) => set('owner', e.target.value)} maxLength={120} />
        </FormField>
        <FormField label="Owner email">
          <input className="input" type="email" value={f.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />
        </FormField>
        <FormField label="Tags" hint="Comma separated" className="span-2">
          <input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="team-a, production" />
        </FormField>
      </div>

      <div className="section-title mt-3">Gateway settings</div>
      <div className="form-grid">
        <FormField label="Response cache" hint="Cache identical requests to save cost and latency.">
          <Checkbox checked={f.cacheEnabled} onChange={(v) => set('cacheEnabled', v)} label="Enable caching for this app" />
        </FormField>
        <FormField label="Cache TTL (seconds)" hint="Blank = gateway default">
          <input className="input" type="number" min={1} value={f.cacheTtlSeconds} onChange={(e) => set('cacheTtlSeconds', e.target.value)} disabled={!f.cacheEnabled} />
        </FormField>
        <FormField label="Body logging" hint="Stores encrypted prompts/responses for debugging (sensitive).">
          <select className="select" value={f.logBodies} onChange={(e) => set('logBodies', e.target.value as AppForm['logBodies'])}>
            {<option value="inherit">Inherit gateway default (Settings › Gateway)</option>}
            <option value="on">Store request & response bodies</option>
            <option value="off">Do not store bodies</option>
          </select>
        </FormField>
        <FormField label="Rate limit (requests/min)" hint="0 or blank = unlimited">
          <input className="input" type="number" min={0} value={f.rpm} onChange={(e) => set('rpm', e.target.value)} />
        </FormField>
        <FormField label="Default model" hint="Used when a client omits 'model'. Model or route slug." className="span-2">
          <input className="input" list="default-model-options" value={f.defaultModel} onChange={(e) => set('defaultModel', e.target.value)} placeholder="e.g. openai/gpt-4.1-mini" />
          <datalist id="default-model-options">
            {defaultModelOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FormField>
        <FormField label="Guardrail policies" hint="Applied in addition to default policies.">
          <MultiSelect options={(guardrails.data ?? []).map((g) => ({ value: g.id, label: g.name, hint: g.isDefault ? 'default' : g.status }))} value={f.guardrailPolicyIds} onChange={(v) => set('guardrailPolicyIds', v)} height={150} />
        </FormField>
        <FormField label="Allowed models" hint="Empty = all models allowed.">
          <MultiSelect options={modelOptions} value={f.allowedModelIds} onChange={(v) => set('allowedModelIds', v)} height={150} />
        </FormField>
      </div>
    </Modal>
  );
}

export default function Apps() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<App[]>('/api/admin/apps');
  const [edit, setEdit] = useState<{ app?: App } | null>(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((a) => !s || a.name.toLowerCase().includes(s) || a.slug.includes(s) || a.owner?.toLowerCase().includes(s) || a.tags?.some((t) => t.toLowerCase().includes(s)));
  }, [data, q]);

  const columns: Column<App>[] = [
    {
      key: 'name',
      header: 'App',
      render: (a) => (
        <div>
          <div className="cell-title">{a.name}</div>
          <div className="cell-sub mono">{a.slug}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'owner', header: 'Owner', render: (a) => (a.owner || a.ownerEmail ? <div><div>{a.owner}</div><div className="cell-sub">{a.ownerEmail}</div></div> : <span className="muted">-</span>) },
    { key: 'activeKeys', header: 'Keys (active / total)', numeric: true, render: (a) => `${a.activeKeys ?? 0} / ${a.totalKeys ?? 0}` },
    {
      key: 'settings',
      header: 'Settings',
      sortable: false,
      hideSm: true,
      render: (a) => (
        <div className="chips">
          {a.settings?.cacheEnabled && <Badge tone="info">cache</Badge>}
          {a.settings?.logBodies && <Badge tone="warning">body logging</Badge>}
          {!!a.settings?.rpm && <Badge>{a.settings.rpm} rpm</Badge>}
          {!!a.settings?.allowedModelIds?.length && <Badge>{a.settings.allowedModelIds.length} models</Badge>}
          {!!a.settings?.guardrailPolicyIds?.length && <Badge>{a.settings.guardrailPolicyIds.length} guardrails</Badge>}
        </div>
      ),
    },
    { key: 'tags', header: 'Tags', sortable: false, hideSm: true, render: (a) => <div className="chips">{(a.tags ?? []).map((t) => <span key={t} className="chip">{t}</span>)}</div> },
    { key: 'createdAt', header: 'Created', hideSm: true, render: (a) => fmtDate(a.createdAt) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (a) =>
        canEdit && (
          <button className="btn btn-sm" onClick={() => setEdit({ app: a })}>
            <Pencil size={13} /> Edit
          </button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Apps"
        subtitle="Applications that consume the gateway. Keys, budgets, caching, body logging and guardrails are configured per app."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setEdit({})}>
              <Plus size={15} /> New app
            </button>
          )
        }
      />
      <div className="toolbar">
        <div className="input-icon search">
          <Search size={14} />
          <input className="input" placeholder="Search apps, owners, tags…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={rows} rowKey={(a) => a.id} emptyTitle="No apps yet" emptyText="Create an app, then issue API keys for it." initialSort={{ key: 'name', dir: 'asc' }} />}
      </div>
      <AppModal open={!!edit} app={edit?.app} onClose={() => setEdit(null)} onSaved={reload} />
    </>
  );
}
