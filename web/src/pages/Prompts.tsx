import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useApps, useModels, useRoutes } from '../hooks';
import type { Prompt } from '../types';
import { Badge, ErrorState, FormField, Loading, PageHeader, Spinner } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { fmtDate } from '../format';
import { TemplateEditor, templateFormFrom, templatePayload, type TemplateForm } from './promptParts';

function CreatePromptModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const apps = useApps();
  const models = useModels();
  const routes = useRoutes();
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [appId, setAppId] = useState('');
  const [changelog, setChangelog] = useState('');
  const [t, setT] = useState<TemplateForm>(templateFormFrom());
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) {
      setSlug('');
      setName('');
      setDescription('');
      setAppId('');
      setChangelog('');
      setT(templateFormFrom());
    }
  }, [open]);
  const modelOptions = useMemo(() => [...(models.data ?? []).map((m) => m.slug), ...(routes.data ?? []).map((r) => r.slug)], [models.data, routes.data]);
  const slugOk = /^[a-z0-9._-]+$/.test(slug);
  const create = () =>
    run(async () => {
      const p = await api.post<Prompt>('/api/admin/prompts', {
        slug,
        name: name.trim(),
        description: description.trim() || undefined,
        appId: appId || undefined,
        changelog: changelog.trim() || undefined,
        template: templatePayload(t),
      });
      onClose();
      navigate(`/prompts/${p.id}`);
    }, 'Prompt created');
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="New prompt"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !slugOk || !name.trim() || t.messages.some((m) => !m.content.trim())} onClick={create}>
            {busy && <Spinner size={14} />} Create prompt
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Slug" required hint="Lowercase letters, digits, . _ - (used by callers)" error={slug && !slugOk ? 'Invalid slug' : undefined}>
          <input className="input mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={100} autoFocus />
        </FormField>
        <FormField label="Name" required>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </FormField>
        <FormField label="App" hint="Optional owner app">
          <select className="select" value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">None</option>
            {(apps.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Changelog" hint="Default: Initial version">
          <input className="input" value={changelog} onChange={(e) => setChangelog(e.target.value)} />
        </FormField>
        <FormField label="Description" className="span-2">
          <textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </div>
      <div className="mt-3">
        <TemplateEditor f={t} set={(p) => setT((x) => ({ ...x, ...p }))} modelOptions={modelOptions} />
      </div>
    </Modal>
  );
}

export default function Prompts() {
  const { canEdit } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<Prompt[]>('/api/admin/prompts');
  const apps = useApps();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const rows = (data ?? []).filter((p) => !q || p.slug.includes(q.toLowerCase()) || p.name.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<Prompt>[] = [
    { key: 'slug', header: 'Prompt', render: (p) => <div><div className="cell-title mono">{p.slug}</div><div className="cell-sub">{p.name}</div></div> },
    { key: 'appId', header: 'App', render: (p) => (p.appId ? apps.data?.find((a) => a.id === p.appId)?.name ?? p.appId : <span className="muted">-</span>) },
    { key: 'latestVersion', header: 'Latest', numeric: true, render: (p) => `v${p.latestVersion}` },
    {
      key: 'labels',
      header: 'Labels',
      sortable: false,
      render: (p) => (
        <div className="chips">
          {Object.entries(p.labels ?? {}).map(([l, v]) => (
            <Badge key={l} tone={l === 'production' ? 'success' : l === 'staging' ? 'warning' : 'neutral'}>
              {l}: v{v}
            </Badge>
          ))}
        </div>
      ),
    },
    { key: 'updatedAt', header: 'Updated', render: (p) => fmtDate(p.updatedAt) },
  ];
  return (
    <>
      <PageHeader
        title="Prompts"
        subtitle="Versioned prompt templates managed centrally. Apps reference them by slug and label, so you can ship prompt changes without redeploying."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New prompt
            </button>
          )
        }
      />
      <div className="toolbar">
        <div className="input-icon search">
          <Search size={14} />
          <input className="input" placeholder="Search prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={rows} rowKey={(p) => p.id} onRowClick={(p) => navigate(`/prompts/${p.id}`)} emptyTitle="No prompts yet" />}
      </div>
      <CreatePromptModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
