import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useModels } from '../hooks';
import type { RouteRow, RouteStrategy, RouteTarget } from '../types';
import { Alert, Badge, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { MultiSelect } from '../components/MultiSelect';
import { fmtDate, numStr, optInt, splitList } from '../format';

export const STRATEGIES: { id: RouteStrategy; label: string; text: string }[] = [
  { id: 'fallback', label: 'Fallback', text: 'Try targets in order; on errors, timeouts or rate limits move to the next one.' },
  { id: 'loadbalance', label: 'Load balance', text: 'Spread traffic across targets by weight; failed calls fall back to the remaining targets.' },
  { id: 'cheapest', label: 'Cheapest', text: 'Send each request to the lowest-priced available target, falling back to the next cheapest.' },
  { id: 'auto', label: 'Auto (cheap vs strong)', text: 'Classify each request: short/simple prompts go to cheap models, long prompts or ones with “strong” keywords go to strong models.' },
];

interface RouteForm {
  slug: string;
  name: string;
  description: string;
  strategy: RouteStrategy;
  status: 'active' | 'disabled';
  targets: RouteTarget[];
  cheap: string[];
  strong: string[];
  thresholdTokens: string;
  strongKeywords: string;
  maxAttempts: string;
}

function RouteModal({ open, route, onClose, onSaved }: { open: boolean; route?: RouteRow; onClose: () => void; onSaved: () => void }) {
  const models = useModels();
  const init = (): RouteForm => ({
    slug: route?.slug ?? '',
    name: route?.name ?? '',
    description: route?.description ?? '',
    strategy: route?.strategy ?? 'fallback',
    status: route?.status ?? 'active',
    targets: route?.targets ?? [],
    cheap: route?.autoConfig?.cheap ?? [],
    strong: route?.autoConfig?.strong ?? [],
    thresholdTokens: numStr(route?.autoConfig?.thresholdTokens),
    strongKeywords: (route?.autoConfig?.strongKeywords ?? []).join(', '),
    maxAttempts: numStr(route?.retry?.maxAttempts),
  });
  const [f, setF] = useState<RouteForm>(init);
  const [pick, setPick] = useState('');
  const { busy, run } = useAction();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) setF(init());
  }, [open, route]);
  const set = (p: Partial<RouteForm>) => setF((x) => ({ ...x, ...p }));
  const chat = useMemo(() => (models.data ?? []).filter((m) => m.type === 'chat'), [models.data]);
  const label = (id: string) => models.data?.find((m) => m.id === id)?.slug ?? id;
  const opts = chat.map((m) => ({ value: m.id, label: m.slug, hint: m.tier }));

  const move = (i: number, d: -1 | 1) => {
    const t = [...f.targets];
    const j = i + d;
    if (j < 0 || j >= t.length) return;
    [t[i], t[j]] = [t[j], t[i]];
    set({ targets: t });
  };

  const save = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        slug: f.slug.trim(),
        name: f.name.trim(),
        description: f.description.trim(),
        strategy: f.strategy,
        status: f.status,
        targets: f.strategy === 'auto' ? [] : f.targets.map((t) => (f.strategy === 'loadbalance' ? { modelId: t.modelId, weight: t.weight ?? 1 } : { modelId: t.modelId })),
      };
      const ma = optInt(f.maxAttempts);
      if (ma) body.retry = { maxAttempts: ma };
      if (f.strategy === 'auto') {
        const auto: Record<string, unknown> = { cheap: f.cheap, strong: f.strong };
        const th = optInt(f.thresholdTokens);
        if (th) auto.thresholdTokens = th;
        const kw = splitList(f.strongKeywords);
        if (kw.length) auto.strongKeywords = kw;
        body.autoConfig = auto;
      }
      if (route) await api.patch(`/api/admin/routes/${route.id}`, body);
      else await api.post('/api/admin/routes', body);
      onSaved();
      onClose();
    }, route ? 'Route updated' : 'Route created');

  const valid = f.slug.trim() && f.name.trim() && (f.strategy === 'auto' ? f.cheap.length && f.strong.length : f.targets.length);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={route ? `Edit route: ${route.slug}` : 'New route'}
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
        <FormField label="Slug" required hint='Clients send this as "model", e.g. "chat-default"'>
          <input className="input mono" value={f.slug} onChange={(e) => set({ slug: e.target.value })} maxLength={100} />
        </FormField>
        <FormField label="Name" required>
          <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} />
        </FormField>
        <FormField label="Description" className="span-2">
          <textarea className="textarea" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />
        </FormField>
        <FormField label="Status">
          <select className="select" value={f.status} onChange={(e) => set({ status: e.target.value as RouteForm['status'] })}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </FormField>
        <FormField label="Max attempts" hint="Total upstream attempts across targets (blank = default)">
          <input className="input" type="number" min={1} max={10} value={f.maxAttempts} onChange={(e) => set({ maxAttempts: e.target.value })} />
        </FormField>
      </div>

      <div className="section-title mt-3">Strategy</div>
      <div className="preset-grid">
        {STRATEGIES.map((s) => (
          <button key={s.id} type="button" className="preset" style={f.strategy === s.id ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : undefined} onClick={() => set({ strategy: s.id })}>
            <div className="cell-title">
              <input type="radio" readOnly checked={f.strategy === s.id} style={{ marginRight: 6, accentColor: 'var(--primary)' }} />
              {s.label}
            </div>
            <div className="cell-sub">{s.text}</div>
          </button>
        ))}
      </div>

      {f.strategy !== 'auto' ? (
        <>
          <div className="section-title mt-3">Targets {f.strategy === 'fallback' && <span className="muted">(in priority order)</span>}</div>
          {f.targets.length === 0 && <Alert tone="info">Add at least one target model.</Alert>}
          <div className="list-rows">
            {f.targets.map((t, i) => (
              <div className="editor-row" key={`${t.modelId}-${i}`} style={{ alignItems: 'center' }}>
                <Badge>{i + 1}</Badge>
                <span className="grow mono">{label(t.modelId)}</span>
                {f.strategy === 'loadbalance' && (
                  <label className="row small">
                    weight
                    <input
                      className="input input-sm"
                      type="number"
                      min={0}
                      max={1000}
                      style={{ width: 80 }}
                      value={t.weight ?? 1}
                      onChange={(e) => set({ targets: f.targets.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)) })}
                    />
                  </label>
                )}
                <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Move down" disabled={i === f.targets.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </button>
                <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Remove" onClick={() => set({ targets: f.targets.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="row mt-2">
            <select className="select" style={{ maxWidth: 360 }} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Add target model…</option>
              {chat
                .filter((m) => !f.targets.some((t) => t.modelId === m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.slug}
                    {m.status !== 'active' ? ' (disabled)' : ''}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={!pick || f.targets.length >= 20}
              onClick={() => {
                set({ targets: [...f.targets, { modelId: pick, weight: 1 }] });
                setPick('');
              }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
          {f.strategy === 'loadbalance' && f.targets.length > 0 && (
            <p className="hint mt-1">
              Share:{' '}
              {f.targets
                .map((t) => {
                  const total = f.targets.reduce((s, x) => s + (x.weight ?? 1), 0) || 1;
                  return `${label(t.modelId)} ${(((t.weight ?? 1) / total) * 100).toFixed(0)}%`;
                })
                .join(' · ')}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="form-grid mt-3">
            <FormField label="Cheap models" required hint="Used for simple, short requests (first available wins)">
              <MultiSelect options={opts} value={f.cheap} onChange={(v) => set({ cheap: v.slice(0, 10) })} height={160} />
            </FormField>
            <FormField label="Strong models" required hint="Used for long or complex requests">
              <MultiSelect options={opts} value={f.strong} onChange={(v) => set({ strong: v.slice(0, 10) })} height={160} />
            </FormField>
            <FormField label="Threshold (input tokens)" hint="Above this size requests go to strong models. Blank = Settings › Routing default.">
              <input className="input" type="number" min={1} value={f.thresholdTokens} onChange={(e) => set({ thresholdTokens: e.target.value })} />
            </FormField>
            <FormField label="Strong keywords" hint="Comma separated. Blank = Settings › Routing default.">
              <input className="input" value={f.strongKeywords} onChange={(e) => set({ strongKeywords: e.target.value })} placeholder="analyze, refactor, step by step" />
            </FormField>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function RoutesPage() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<RouteRow[]>('/api/admin/routes');
  const models = useModels();
  const [edit, setEdit] = useState<{ route?: RouteRow } | null>(null);
  const label = (id: string) => models.data?.find((m) => m.id === id)?.slug ?? id;

  const columns: Column<RouteRow>[] = [
    { key: 'slug', header: 'Route', render: (r) => <div><div className="cell-title mono">{r.slug}</div><div className="cell-sub">{r.name}</div></div> },
    { key: 'strategy', header: 'Strategy', render: (r) => <Badge tone="info">{STRATEGIES.find((s) => s.id === r.strategy)?.label ?? r.strategy}</Badge> },
    {
      key: 'targets',
      header: 'Targets',
      sortable: false,
      render: (r) =>
        r.strategy === 'auto' ? (
          <div className="small">
            <div>
              <span className="muted">cheap:</span> {(r.autoConfig?.cheap ?? []).map(label).join(', ')}
            </div>
            <div>
              <span className="muted">strong:</span> {(r.autoConfig?.strong ?? []).map(label).join(', ')}
            </div>
          </div>
        ) : (
          <div className="chips">
            {r.targets.map((t, i) => (
              <span className="chip mono" key={i}>
                {label(t.modelId)}
                {r.strategy === 'loadbalance' ? ` ×${t.weight ?? 1}` : ''}
              </span>
            ))}
          </div>
        ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'updatedAt', header: 'Updated', hideSm: true, render: (r) => fmtDate(r.updatedAt) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (r) =>
        canEdit && (
          <button className="btn btn-sm" onClick={() => setEdit({ route: r })}>
            <Pencil size={13} /> Edit
          </button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Routes"
        subtitle='Virtual model names that map to one or more real models. Clients put the route slug in "model".'
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setEdit({})}>
              <Plus size={15} /> New route
            </button>
          )
        }
      />
      <div className="grid grid-4 mb-2">
        {STRATEGIES.map((s) => (
          <div key={s.id} className="stat">
            <div className="cell-title">{s.label}</div>
            <div className="cell-sub">{s.text}</div>
          </div>
        ))}
      </div>
      <div className="card">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={data ?? []} rowKey={(r) => r.id} emptyTitle="No routes" emptyText="Routes give you fallbacks, load balancing and cost-aware model selection." />}
      </div>
      <RouteModal open={!!edit} route={edit?.route} onClose={() => setEdit(null)} onSaved={reload} />
    </>
  );
}
