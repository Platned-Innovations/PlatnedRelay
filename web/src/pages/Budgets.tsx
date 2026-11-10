import { useEffect, useState } from 'react';
import { Pencil, Plus, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useApps, useEntities, useModels, useProviders } from '../hooks';
import type { ApiKey, Budget, BudgetPeriod, BudgetScope } from '../types';
import { Alert, Badge, ErrorState, FormField, Loading, PageHeader, Progress, Spinner, StatusBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, Modal } from '../components/Modal';
import { fmtNum, fmtUsd, optNum } from '../format';

interface BForm {
  name: string;
  scope: Required<Record<keyof BudgetScope, string>>;
  period: BudgetPeriod;
  amountUsd: string;
  action: 'block' | 'notify';
  thresholds: string;
  notifyEmails: string;
  status: 'active' | 'disabled';
}

function useScopeLookups() {
  const apps = useApps();
  const entities = useEntities();
  const providers = useProviders();
  const models = useModels();
  const keys = useApi<ApiKey[]>('/api/admin/keys', { cached: true });
  return {
    appId: (apps.data ?? []).map((x) => ({ value: x.id, label: x.name })),
    entityId: (entities.data ?? []).map((x) => ({ value: x.id, label: x.name })),
    keyId: (keys.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (${x.displayKey})` })),
    providerId: (providers.data ?? []).map((x) => ({ value: x.id, label: x.name })),
    modelId: (models.data ?? []).map((x) => ({ value: x.id, label: x.slug })),
  };
}

const SCOPE_LABELS: Record<keyof BudgetScope, string> = { appId: 'App', entityId: 'Entity', keyId: 'API key', providerId: 'Provider', modelId: 'Model' };

function BudgetModal({ open, b, onClose, onSaved }: { open: boolean; b?: Budget; onClose: () => void; onSaved: () => void }) {
  const lookups = useScopeLookups();
  const init = (): BForm => ({
    name: b?.name ?? '',
    scope: { appId: b?.scope.appId ?? '', entityId: b?.scope.entityId ?? '', keyId: b?.scope.keyId ?? '', providerId: b?.scope.providerId ?? '', modelId: b?.scope.modelId ?? '' },
    period: b?.period ?? 'monthly',
    amountUsd: b ? String(b.amountUsd) : '',
    action: b?.action ?? 'block',
    thresholds: (b?.thresholds ?? [50, 80, 100]).join(', '),
    notifyEmails: (b?.notifyEmails ?? []).join(', '),
    status: b?.status ?? 'active',
  });
  const [f, setF] = useState<BForm>(init);
  const { busy, run } = useAction();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) setF(init());
  }, [open, b]);
  const thresholds = f.thresholds.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const thresholdsOk = f.thresholds.split(',').every((s) => !s.trim() || (Number(s) >= 1 && Number(s) <= 100));
  const amount = optNum(f.amountUsd);
  const global = Object.values(f.scope).every((v) => !v);
  const save = () =>
    run(async () => {
      const body = {
        name: f.name.trim(),
        scope: Object.fromEntries(Object.entries(f.scope).filter(([, v]) => v)),
        period: f.period,
        amountUsd: amount,
        action: f.action,
        thresholds,
        notifyEmails: f.notifyEmails.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
        status: f.status,
      };
      if (b) await api.patch(`/api/admin/budgets/${b.id}`, body);
      else await api.post('/api/admin/budgets', body);
      onSaved();
      onClose();
    }, b ? 'Spend cap updated' : 'Spend cap created');
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={b ? `Edit spend cap: ${b.name}` : 'New spend cap'}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !f.name.trim() || !amount || amount <= 0 || !thresholdsOk} onClick={save}>
            {busy && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Name" required className="span-2">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        </FormField>
      </div>
      <div className="section-title mt-3">Scope</div>
      <p className="hint">Spend matching all selected dimensions counts toward this cap. Leave everything empty for a global cap.</p>
      <div className="form-grid form-grid-3">
        {(Object.keys(SCOPE_LABELS) as (keyof BudgetScope)[]).map((k) => (
          <FormField key={k} label={SCOPE_LABELS[k]}>
            <select className="select" value={f.scope[k]} onChange={(e) => setF({ ...f, scope: { ...f.scope, [k]: e.target.value } })}>
              <option value="">Any</option>
              {lookups[k].map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FormField>
        ))}
      </div>
      {global && (
        <div className="mt-1">
          <Alert tone="warning">This is a global cap: it counts all gateway spend.</Alert>
        </div>
      )}
      <div className="section-title mt-3">Limit</div>
      <div className="form-grid form-grid-3">
        <FormField label="Amount (USD)" required>
          <input className="input" type="number" min={0.01} step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} />
        </FormField>
        <FormField label="Period" hint="Periods reset in UTC">
          <select className="select" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as BudgetPeriod })}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="total">Total (never resets)</option>
          </select>
        </FormField>
        <FormField label="When reached">
          <select className="select" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as BForm['action'] })}>
            <option value="block">Block further requests</option>
            <option value="notify">Notify only</option>
          </select>
        </FormField>
        <FormField label="Alert thresholds (%)" hint="Comma separated, 1-100" error={thresholdsOk ? undefined : 'Values must be between 1 and 100'}>
          <input className="input" value={f.thresholds} onChange={(e) => setF({ ...f, thresholds: e.target.value })} />
        </FormField>
        <FormField label="Notify emails" hint="Comma separated; admins per notification settings also receive alerts" className="span-2">
          <input className="input" value={f.notifyEmails} onChange={(e) => setF({ ...f, notifyEmails: e.target.value })} />
        </FormField>
        <FormField label="Status">
          <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as BForm['status'] })}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </FormField>
      </div>
    </Modal>
  );
}

export default function Budgets() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<Budget[]>('/api/admin/budgets');
  const lookups = useScopeLookups();
  const [edit, setEdit] = useState<{ b?: Budget } | null>(null);
  const [reset, setReset] = useState<Budget | null>(null);

  const scopeText = (s: BudgetScope) => {
    const parts = (Object.keys(SCOPE_LABELS) as (keyof BudgetScope)[])
      .filter((k) => s[k])
      .map((k) => `${SCOPE_LABELS[k]}: ${lookups[k].find((o) => o.value === s[k])?.label ?? s[k]}`);
    return parts.length ? parts : ['Global'];
  };

  const columns: Column<Budget>[] = [
    { key: 'name', header: 'Spend cap', render: (b) => <div><div className="cell-title">{b.name}</div><div className="chips mt-1">{scopeText(b.scope).map((t) => <span key={t} className="chip">{t}</span>)}</div></div> },
    { key: 'period', header: 'Period', render: (b) => <div><div>{b.period}</div><div className="cell-sub mono">{b.periodKey}</div></div> },
    {
      key: 'percent',
      header: 'Usage',
      render: (b) => (
        <div style={{ minWidth: 180 }}>
          <div className="row between small">
            <span>
              {fmtUsd(b.spentUsd)} / {fmtUsd(b.amountUsd)}
            </span>
            <strong>{b.percent.toFixed(1)}%</strong>
          </div>
          <Progress percent={b.percent} />
          <div className="cell-sub">{fmtNum(b.requests)} requests this period</div>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (b) => (
        <div className="stack" style={{ gap: 2 }}>
          <Badge tone={b.action === 'block' ? 'danger' : 'info'}>{b.action}</Badge>
          {b.exceeded && <Badge tone="danger" dot>exceeded</Badge>}
        </div>
      ),
    },
    { key: 'thresholds', header: 'Alerts at', hideSm: true, render: (b) => b.thresholds.map((t) => `${t}%`).join(', ') },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.status} /> },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (b) =>
        canEdit && (
          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
            <button className="btn btn-sm" onClick={() => setReset(b)} title="Reset current period">
              <RotateCcw size={13} /> Reset
            </button>
            <button className="btn btn-sm" onClick={() => setEdit({ b })}>
              <Pencil size={13} /> Edit
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Spend caps"
        subtitle="Budgets on any scope (app, entity, key, provider, model or global). Block traffic or alert when limits are approached."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setEdit({})}>
              <Plus size={15} /> New spend cap
            </button>
          )
        }
      />
      <div className="card">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={data ?? []} rowKey={(b) => b.id} emptyTitle="No spend caps" initialSort={{ key: 'percent', dir: 'desc' }} />}
      </div>
      <BudgetModal open={!!edit} b={edit?.b} onClose={() => setEdit(null)} onSaved={reload} />
      <ConfirmDialog
        open={!!reset}
        title={`Reset ${reset?.name}?`}
        message={`Clears the spend counter for the current period (${reset?.periodKey}). Usage records are not deleted. If the cap was blocking, traffic resumes.`}
        confirmLabel="Reset period"
        onConfirm={async () => {
          await api.post(`/api/admin/budgets/${reset!.id}/reset`);
          reload();
        }}
        onClose={() => setReset(null)}
      />
    </>
  );
}
