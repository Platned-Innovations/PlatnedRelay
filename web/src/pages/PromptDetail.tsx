import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, Pencil, Plus, Tag, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useModels, useRoutes } from '../hooks';
import type { PromptDetail as PD, PromptVersion } from '../types';
import { Badge, Card, CodeBlock, Empty, ErrorState, FormField, Loading, PageHeader, Spinner } from '../components/ui';
import { Modal } from '../components/Modal';
import { fmtDate } from '../format';
import { TemplateEditor, templateFormFrom, templatePayload, type TemplateForm } from './promptParts';

function NewVersionModal({ open, base, promptId, onClose, onSaved }: { open: boolean; base?: PromptVersion; promptId: string; onClose: () => void; onSaved: (v: number) => void }) {
  const models = useModels();
  const routes = useRoutes();
  const [t, setT] = useState<TemplateForm>(templateFormFrom(base?.template));
  const [changelog, setChangelog] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) {
      setT(templateFormFrom(base?.template));
      setChangelog('');
    }
  }, [open, base]);
  const modelOptions = useMemo(() => [...(models.data ?? []).map((m) => m.slug), ...(routes.data ?? []).map((r) => r.slug)], [models.data, routes.data]);
  const save = () =>
    run(async () => {
      const v = await api.post<PromptVersion>(`/api/admin/prompts/${promptId}/versions`, { template: templatePayload(t), changelog: changelog.trim() || undefined });
      onSaved(v.version);
      onClose();
    }, 'New version created');
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={`New version${base ? ` (based on v${base.version})` : ''}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || t.messages.some((m) => !m.content.trim())} onClick={save}>
            {busy && <Spinner size={14} />} Create version
          </button>
        </>
      }
    >
      <FormField label="Changelog" hint="What changed and why">
        <input className="input" value={changelog} onChange={(e) => setChangelog(e.target.value)} maxLength={2000} autoFocus />
      </FormField>
      <div className="mt-3">
        <TemplateEditor f={t} set={(p) => setT((x) => ({ ...x, ...p }))} modelOptions={modelOptions} />
      </div>
      <p className="hint mt-2">New versions are not used by callers until you move a label (e.g. production) to them.</p>
    </Modal>
  );
}

function EditMetaModal({ open, prompt, onClose, onSaved }: { open: boolean; prompt: PD; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(prompt.name);
  const [description, setDescription] = useState(prompt.description ?? '');
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) {
      setName(prompt.name);
      setDescription(prompt.description ?? '');
    }
  }, [open, prompt]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit prompt details"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              run(async () => {
                await api.patch(`/api/admin/prompts/${prompt.id}`, { name: name.trim(), description });
                onSaved();
                onClose();
              }, 'Prompt updated')
            }
          >
            Save
          </button>
        </>
      }
    >
      <FormField label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </FormField>
      <FormField label="Description">
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </FormField>
    </Modal>
  );
}

export default function PromptDetail() {
  const { id = '' } = useParams();
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<PD>(`/api/admin/prompts/${id}`);
  const [selected, setSelected] = useState<number | null>(null);
  const [newVersion, setNewVersion] = useState(false);
  const [editMeta, setEditMeta] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ version: number; messages: { role: string; content: string }[] } | null>(null);
  const { busy, run } = useAction();

  const version = data?.versions.find((v) => v.version === (selected ?? data.labels?.production ?? data.latestVersion)) ?? data?.versions[0];
  useEffect(() => setPreview(null), [version?.version]);

  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const labelsFor = (v: number) => Object.entries(data.labels ?? {}).filter(([, n]) => n === v).map(([l]) => l);
  const setLabel = (label: string, v: number | null) =>
    run(async () => {
      await api.post(`/api/admin/prompts/${data.id}/labels`, { label, version: v });
      reload();
    }, v === null ? `Label "${label}" removed` : `Label "${label}" → v${v}`);

  const render = () =>
    run(async () => {
      if (!version) return;
      const variables: Record<string, unknown> = {};
      for (const k of version.variables) variables[k] = vars[k] ?? '';
      setPreview(await api.post(`/api/admin/prompts/${data.id}/render`, { version: version.version, variables }));
    });

  const snippetLabel = version ? labelsFor(version.version)[0] ?? 'production' : 'production';
  const snippet = `{
  "model": "${version?.template.model ?? 'YOUR_MODEL_OR_ROUTE'}",
  "messages": [],
  "relay": {
    "prompt": {
      "slug": "${data.slug}",
      "label": "${snippetLabel}",
      "variables": {${(version?.variables ?? []).map((v) => `\n        "${v}": "..."`).join(',')}${version?.variables.length ? '\n      ' : ''}}
    }
  }
}`;
  const pySnippet = `resp = client.chat.completions.create(
    model="${version?.template.model ?? 'YOUR_MODEL_OR_ROUTE'}",
    messages=[],
    extra_body={"relay": {"prompt": {"slug": "${data.slug}", "label": "${snippetLabel}", "variables": {${(version?.variables ?? []).map((v) => `"${v}": "..."`).join(', ')}}}}},
)`;

  return (
    <>
      <Link to="/prompts" className="small row" style={{ gap: 4, marginBottom: 8 }}>
        <ArrowLeft size={13} /> All prompts
      </Link>
      <PageHeader
        title={
          <>
            {data.name} <span className="mono muted" style={{ fontSize: 14, fontWeight: 500 }}>{data.slug}</span>
          </>
        }
        subtitle={data.description}
        actions={
          canEdit && (
            <>
              <button className="btn" onClick={() => setEditMeta(true)}>
                <Pencil size={14} /> Edit details
              </button>
              <button className="btn btn-primary" onClick={() => setNewVersion(true)}>
                <Plus size={15} /> New version
              </button>
            </>
          )
        }
      />
      <div className="grid split">
        <Card title="Versions" flush>
          <ul className="ranked">
            {data.versions.map((v) => (
              <li key={v.id} style={{ cursor: 'pointer', background: v.version === version?.version ? 'var(--primary-soft)' : undefined }} onClick={() => setSelected(v.version)}>
                <span className="name">
                  <strong>v{v.version}</strong> <span className="muted small">{fmtDate(v.createdAt)}</span>
                </span>
                <span className="chips">
                  {labelsFor(v.version).map((l) => (
                    <Badge key={l} tone={l === 'production' ? 'success' : l === 'staging' ? 'warning' : 'neutral'}>
                      {l}
                    </Badge>
                  ))}
                </span>
                <span className="cell-sub" style={{ gridColumn: '1 / -1' }}>
                  {v.changelog || 'No changelog'} {v.createdBy ? `· ${v.createdBy}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {version ? (
          <div className="stack">
            <Card
              title={`Version ${version.version}`}
              actions={
                <div className="chips">
                  {labelsFor(version.version).map((l) => (
                    <span className="chip" key={l}>
                      <Tag size={11} /> {l}
                      {canEdit && (
                        <button aria-label={`Remove label ${l}`} onClick={() => setLabel(l, null)} title="Remove label">
                          <X size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              }
            >
              {canEdit && (
                <div className="row mb-2">
                  <span className="small muted">Set label:</span>
                  {['production', 'staging'].map((l) => (
                    <button key={l} className="btn btn-sm" disabled={busy || data.labels?.[l] === version.version} onClick={() => setLabel(l, version.version)}>
                      {l}
                    </button>
                  ))}
                  <input
                    className="input input-sm"
                    style={{ width: 140 }}
                    placeholder="custom-label"
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value.toLowerCase())}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={busy || !/^[a-z0-9_-]+$/.test(customLabel)}
                    onClick={() => {
                      void setLabel(customLabel, version.version);
                      setCustomLabel('');
                    }}
                  >
                    Apply
                  </button>
                </div>
              )}
              <div className="stack" style={{ gap: 8 }}>
                {version.template.messages.map((m, i) => (
                  <div key={i} className="msg-editor">
                    <div className="msg-role">{m.role}</div>
                    <pre className="wrap" style={{ border: 0, background: 'transparent', padding: 0 }}>
                      {m.content}
                    </pre>
                  </div>
                ))}
              </div>
              <div className="row mt-2 small">
                {version.template.model && (
                  <span>
                    <span className="muted">model</span> <code>{version.template.model}</code>
                  </span>
                )}
                {Object.entries(version.template.params ?? {}).map(([k, v]) => (
                  <span key={k}>
                    <span className="muted">{k}</span> <code>{String(v)}</code>
                  </span>
                ))}
                <span>
                  <span className="muted">variables</span> {version.variables.length ? version.variables.map((v) => <code key={v}>{v}</code>) : <span className="muted">none</span>}
                </span>
              </div>
            </Card>

            <Card title="Render preview">
              {version.variables.length === 0 && <p className="muted small">This version has no variables.</p>}
              <div className="form-grid">
                {version.variables.map((v) => (
                  <FormField key={v} label={v}>
                    <textarea className="textarea" rows={2} value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} />
                  </FormField>
                ))}
              </div>
              <button className="btn mt-2" onClick={render} disabled={busy}>
                <Eye size={14} /> Render
              </button>
              {preview && (
                <div className="stack mt-2" style={{ gap: 8 }}>
                  {preview.messages.map((m, i) => (
                    <div key={i} className="msg-editor">
                      <div className="msg-role">{m.role}</div>
                      <pre className="wrap" style={{ border: 0, background: 'transparent', padding: 0 }}>
                        {m.content}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Usage">
              <p className="small text-2">
                Send a normal chat completion to <code>/v1/chat/completions</code> with a <code>relay.prompt</code> reference. Resolution order: explicit <code>version</code> › <code>label</code> › production › latest. Your own messages are appended after the template.
              </p>
              <div className="section-title">Request body</div>
              <CodeBlock code={snippet} />
              <div className="section-title">Python (OpenAI SDK)</div>
              <CodeBlock code={pySnippet} />
            </Card>
          </div>
        ) : (
          <Empty title="No versions" />
        )}
      </div>
      <NewVersionModal open={newVersion} base={version} promptId={data.id} onClose={() => setNewVersion(false)} onSaved={(v) => { setSelected(v); reload(); }} />
      <EditMetaModal open={editMeta} prompt={data} onClose={() => setEditMeta(false)} onSaved={reload} />
    </>
  );
}
