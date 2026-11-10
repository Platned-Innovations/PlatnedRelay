import { useEffect, useMemo, useState } from 'react';
import { Ban, CalendarClock, Pause, Pencil, Play, Plus, RotateCw, Search } from 'lucide-react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useApps, useDebounced, useEntities, useModels, useProviders, useRoutes } from '../hooks';
import { ENTITY_TYPES, type ApiKey, type BudgetPeriod, type EntityType, type KeyDetail, type KeySecretResponse } from '../types';
import { Alert, Badge, ErrorState, FormField, KV, Loading, PageHeader, Spinner, StatusBadge, Empty } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, Drawer, Modal } from '../components/Modal';
import { fmtDate, fmtNum, fmtRelative, fmtUsd, fromLocalInput, optNum, titleCase } from '../format';
import { AccessEditor, accessFormFrom, accessPayload, SecretModal, type AccessForm } from './keyParts';

export function keyStatus(k: Pick<ApiKey, 'status' | 'expired'>): string {
  if (k.status === 'revoked') return 'revoked';
  if (k.expired) return 'expired';
  return k.status;
}

// ---------------- Create ----------------
interface CreateForm {
  name: string;
  appId: string;
  entityMode: 'existing' | 'new';
  entityId: string;
  newEntity: { name: string; type: EntityType; email: string };
  expires: boolean;
  expiresAt: string;
  budget: boolean;
  budgetAmount: string;
  budgetPeriod: BudgetPeriod;
  budgetAction: 'block' | 'notify';
}

function CreateKeyModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: KeySecretResponse) => void }) {
  const apps = useApps();
  const entities = useEntities();
  const blank = (): CreateForm => ({
    name: '',
    appId: '',
    entityMode: 'existing',
    entityId: '',
    newEntity: { name: '', type: 'user', email: '' },
    expires: false,
    expiresAt: '',
    budget: false,
    budgetAmount: '',
    budgetPeriod: 'monthly',
    budgetAction: 'block',
  });
  const [f, setF] = useState<CreateForm>(blank);
  const [acc, setAcc] = useState<AccessForm>(accessFormFrom());
  const [step, setStep] = useState(1);
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) {
      setF(blank());
      setAcc(accessFormFrom());
      setStep(1);
    }
  }, [open]);
  const set = (p: Partial<CreateForm>) => setF((x) => ({ ...x, ...p }));

  const step1Valid =
    f.name.trim() && f.appId && (f.entityMode === 'existing' ? !!f.entityId : !!f.newEntity.name.trim()) && (!f.expires || !!fromLocalInput(f.expiresAt)) && (!f.budget || (optNum(f.budgetAmount) ?? 0) > 0);

  const create = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        name: f.name.trim(),
        appId: f.appId,
        ...(f.entityMode === 'existing' ? { entityId: f.entityId } : { newEntity: { name: f.newEntity.name.trim(), type: f.newEntity.type, email: f.newEntity.email.trim() } }),
        expiresAt: f.expires ? fromLocalInput(f.expiresAt) : null,
        ...accessPayload(acc),
      };
      if (f.budget) body.budget = { amountUsd: optNum(f.budgetAmount), period: f.budgetPeriod, action: f.budgetAction };
      const r = await api.post<KeySecretResponse>('/api/admin/keys', body);
      onCreated(r);
      onClose();
    }, 'API key created');

  const minDate = new Date(Date.now() + 3600_000);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create API key"
      size="xl"
      footer={
        <>
          {step === 2 && (
            <button className="btn left" onClick={() => setStep(1)}>
              Back
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {step === 1 ? (
            <button className="btn btn-primary" disabled={!step1Valid} onClick={() => setStep(2)}>
              Next: access & limits
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || !step1Valid} onClick={create}>
              {busy && <Spinner size={14} />} Create key
            </button>
          )}
        </>
      }
    >
      <div className="steps">
        <div className={`step${step === 1 ? ' active' : ' done'}`}>
          <span className="n">1</span> Owner & lifetime
        </div>
        <div className={`step${step === 2 ? ' active' : ''}`}>
          <span className="n">2</span> Access, limits & metadata
        </div>
      </div>
      {step === 1 ? (
        <>
          <div className="form-grid">
            <FormField label="Key name" required hint="Describe where it is used, e.g. 'billing-service prod'">
              <input className="input" value={f.name} maxLength={120} autoFocus onChange={(e) => set({ name: e.target.value })} />
            </FormField>
            <FormField label="App" required hint="Cannot be changed later">
              <select className="select" value={f.appId} onChange={(e) => set({ appId: e.target.value })}>
                <option value="">Select an app…</option>
                {(apps.data ?? []).map((a) => (
                  <option key={a.id} value={a.id} disabled={a.status !== 'active'}>
                    {a.name}
                    {a.status !== 'active' ? ' (disabled)' : ''}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <div className="section-title mt-3">Entity (who owns this key)</div>
          <div className="btn-group mb-2">
            <button type="button" className={`btn btn-sm${f.entityMode === 'existing' ? ' active' : ''}`} onClick={() => set({ entityMode: 'existing' })}>
              Pick existing
            </button>
            <button type="button" className={`btn btn-sm${f.entityMode === 'new' ? ' active' : ''}`} onClick={() => set({ entityMode: 'new' })}>
              Create new
            </button>
          </div>
          {f.entityMode === 'existing' ? (
            <FormField label="Entity" required hint="Cannot be changed later">
              <select className="select" value={f.entityId} onChange={(e) => set({ entityId: e.target.value })}>
                <option value="">Select an entity…</option>
                {(entities.data ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.type}){e.email ? ` - ${e.email}` : ''}
                  </option>
                ))}
              </select>
            </FormField>
          ) : (
            <div className="form-grid form-grid-3">
              <FormField label="Name" required>
                <input className="input" value={f.newEntity.name} maxLength={120} onChange={(e) => set({ newEntity: { ...f.newEntity, name: e.target.value } })} />
              </FormField>
              <FormField label="Type">
                <select className="select" value={f.newEntity.type} onChange={(e) => set({ newEntity: { ...f.newEntity, type: e.target.value as EntityType } })}>
                  {ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {titleCase(t)}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Email" hint="Optional; receives key notifications">
                <input className="input" type="email" value={f.newEntity.email} onChange={(e) => set({ newEntity: { ...f.newEntity, email: e.target.value } })} />
              </FormField>
            </div>
          )}

          <div className="section-title mt-3">Expiry</div>
          <Alert tone="warning" title="The expiry date cannot be changed after the key is created">
            Choose carefully. To extend access later you will need to issue a new key. Expired keys stop working immediately and cannot be reactivated.
          </Alert>
          <div className="row mt-2">
            <label className="check">
              <input type="checkbox" checked={f.expires} onChange={(e) => set({ expires: e.target.checked })} /> Set an expiry date
            </label>
            {f.expires && (
              <input
                type="datetime-local"
                className="input"
                style={{ width: 230 }}
                value={f.expiresAt}
                min={`${minDate.getFullYear()}-${String(minDate.getMonth() + 1).padStart(2, '0')}-${String(minDate.getDate()).padStart(2, '0')}T00:00`}
                onChange={(e) => set({ expiresAt: e.target.value })}
              />
            )}
            {!f.expires && <span className="muted small">The key never expires (not recommended for people).</span>}
          </div>

          <div className="section-title mt-3">Spend cap (optional)</div>
          <label className="check">
            <input type="checkbox" checked={f.budget} onChange={(e) => set({ budget: e.target.checked })} /> Add a spend cap for this key
          </label>
          {f.budget && (
            <div className="form-grid form-grid-3 mt-2">
              <FormField label="Amount (USD)" required>
                <input className="input" type="number" min={0.01} step="0.01" value={f.budgetAmount} onChange={(e) => set({ budgetAmount: e.target.value })} />
              </FormField>
              <FormField label="Period">
                <select className="select" value={f.budgetPeriod} onChange={(e) => set({ budgetPeriod: e.target.value as BudgetPeriod })}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="total">Total (lifetime)</option>
                </select>
              </FormField>
              <FormField label="When reached">
                <select className="select" value={f.budgetAction} onChange={(e) => set({ budgetAction: e.target.value as 'block' | 'notify' })}>
                  <option value="block">Block requests</option>
                  <option value="notify">Notify only</option>
                </select>
              </FormField>
            </div>
          )}
        </>
      ) : (
        <AccessEditor f={acc} set={(p) => setAcc((x) => ({ ...x, ...p }))} />
      )}
    </Modal>
  );
}

// ---------------- Edit ----------------
function EditKeyModal({ k, onClose, onSaved }: { k: KeyDetail | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [acc, setAcc] = useState<AccessForm>(accessFormFrom());
  const { busy, run } = useAction();
  useEffect(() => {
    if (k) {
      setName(k.name);
      setAcc(accessFormFrom(k));
    }
  }, [k]);
  if (!k) return null;
  const save = () =>
    run(async () => {
      await api.patch(`/api/admin/keys/${k.id}`, { name: name.trim(), ...accessPayload(acc) });
      onSaved();
      onClose();
    }, 'Key updated');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit key: ${k.name}`}
      size="xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
            {busy && <Spinner size={14} />} Save changes
          </button>
        </>
      }
    >
      <Alert tone="info">App, entity and expiry date are fixed for the lifetime of a key.</Alert>
      <FormField label="Key name" className="mt-2">
        <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <div className="mt-3">
        <AccessEditor f={acc} set={(p) => setAcc((x) => ({ ...x, ...p }))} />
      </div>
    </Modal>
  );
}

// ---------------- Detail drawer ----------------
type KeyAction = 'deactivate' | 'reactivate' | 'regenerate' | 'revoke';

function KeyDrawer({ id, onClose, onChanged, onSecret }: { id: string | null; onClose: () => void; onChanged: () => void; onSecret: (r: KeySecretResponse) => void }) {
  const { canEdit } = useAuth();
  const { data: k, error, loading, reload } = useApi<KeyDetail>(id ? `/api/admin/keys/${id}` : null);
  const providers = useProviders();
  const models = useModels();
  const routes = useRoutes();
  const [action, setAction] = useState<KeyAction | null>(null);
  const [editing, setEditing] = useState(false);
  if (!id) return null;
  const pName = (x: string) => providers.data?.find((r) => r.id === x)?.name ?? x;
  const mName = (x: string) => models.data?.find((r) => r.id === x)?.slug ?? x;
  const rName = (x: string) => routes.data?.find((r) => r.id === x)?.slug ?? x;
  const st = k ? keyStatus(k) : '';
  const doAction = async (reason: string) => {
    if (!k || !action) return;
    const path = `/api/admin/keys/${k.id}/${action}`;
    if (action === 'regenerate') {
      const r = await api.post<KeySecretResponse>(path, { reason: reason || undefined });
      onSecret(r);
    } else await api.post(path, { reason: reason || undefined });
    reload();
    onChanged();
  };
  const usable = k && k.status !== 'revoked';
  return (
    <>
      <Drawer
        open
        wide
        onClose={onClose}
        title={k ? k.name : 'API key'}
        headerExtra={k && <StatusBadge status={st} />}
        footer={
          canEdit &&
          usable && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </button>
              {k.status === 'active' && (
                <button className="btn" onClick={() => setAction('deactivate')}>
                  <Pause size={14} /> Deactivate
                </button>
              )}
              {k.status === 'inactive' && !k.expired && (
                <button className="btn" onClick={() => setAction('reactivate')}>
                  <Play size={14} /> Reactivate
                </button>
              )}
              {!k.expired && (
                <button className="btn" onClick={() => setAction('regenerate')}>
                  <RotateCw size={14} /> Regenerate secret
                </button>
              )}
              <button className="btn btn-danger" style={{ marginLeft: 'auto' }} onClick={() => setAction('revoke')}>
                <Ban size={14} /> Revoke permanently
              </button>
            </>
          )
        }
      >
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !k || loading ? (
          <Loading />
        ) : (
          <>
            {k.status === 'revoked' && (
              <div className="mb-2">
                <Alert tone="danger" title="This key is permanently revoked">
                  Revoked {fmtDate(k.revokedAt)}
                  {k.revokeReason ? ` - ${k.revokeReason}` : ''}. Keys are never deleted so usage history remains attributable.
                </Alert>
              </div>
            )}
            {k.expired && k.status !== 'revoked' && (
              <div className="mb-2">
                <Alert tone="warning" title="This key has expired">
                  Expired {fmtDate(k.expiresAt)}. Issue a new key to restore access.
                </Alert>
              </div>
            )}
            <KV
              items={[
                ['Key', <code key="k">{k.displayKey}</code>],
                ['App', k.appName ?? k.appId],
                ['Entity', <>{k.entityName ?? k.entityId} {k.entityType && <Badge>{k.entityType}</Badge>}</>],
                ['Status', <StatusBadge key="s" status={st} />],
                ['Expires', k.expiresAt ? <>{fmtDate(k.expiresAt)} <span className="muted">({fmtRelative(k.expiresAt)})</span></> : 'Never'],
                ['Created', fmtDate(k.createdAt)],
                ['Last used', k.lastUsedAt ? `${fmtDate(k.lastUsedAt)} (${fmtRelative(k.lastUsedAt)})` : 'Never'],
                ['Secret rotations', k.rotationCount ? `${k.rotationCount} (last ${fmtDate(k.rotatedAt)})` : '0'],
                [
                  'Access',
                  k.access.mode === 'all' ? (
                    'All models & routes'
                  ) : (
                    <div className="stack" style={{ gap: 4 }}>
                      {!!k.access.providerIds?.length && <div>Providers: <div className="chips">{k.access.providerIds.map((x) => <span className="chip" key={x}>{pName(x)}</span>)}</div></div>}
                      {!!k.access.modelIds?.length && <div>Models: <div className="chips">{k.access.modelIds.map((x) => <span className="chip" key={x}>{mName(x)}</span>)}</div></div>}
                      {!!k.access.routeIds?.length && <div>Routes: <div className="chips">{k.access.routeIds.map((x) => <span className="chip" key={x}>{rName(x)}</span>)}</div></div>}
                      {!k.access.providerIds?.length && !k.access.modelIds?.length && !k.access.routeIds?.length && <span className="danger-text">Restricted with nothing selected - no access</span>}
                    </div>
                  ),
                ],
                [
                  'Limits',
                  Object.keys(k.limits ?? {}).length ? (
                    <div className="chips">
                      {k.limits?.rpm !== undefined && <span className="chip">{k.limits.rpm} rpm</span>}
                      {k.limits?.tpm !== undefined && <span className="chip">{fmtNum(k.limits.tpm)} tpm</span>}
                      {k.limits?.maxTokensPerRequest !== undefined && <span className="chip">{fmtNum(k.limits.maxTokensPerRequest)} max tokens/req</span>}
                      {k.limits?.maxConcurrent !== undefined && <span className="chip">{k.limits.maxConcurrent} concurrent</span>}
                    </div>
                  ) : (
                    'Defaults'
                  ),
                ],
                ['IP allowlist', k.ipAllowlist?.length ? <div className="chips">{k.ipAllowlist.map((ip) => <span className="chip mono" key={ip}>{ip}</span>)}</div> : 'Any IP'],
                ['Metadata', Object.keys(k.metadata ?? {}).length ? <pre className="wrap">{JSON.stringify(k.metadata, null, 2)}</pre> : undefined],
                ['ID', <code key="id">{k.id}</code>],
              ]}
            />
            <div className="section-title mt-3">Event history</div>
            {k.events.length === 0 ? (
              <Empty title="No events" />
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Event</th>
                    <th>By</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {k.events.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap">{fmtDate(e.createdAt)}</td>
                      <td>
                        <Badge tone={e.event === 'revoked' ? 'danger' : e.event === 'created' ? 'success' : e.event === 'regenerated' ? 'info' : 'neutral'}>{e.event}</Badge>
                      </td>
                      <td>{e.actorName ?? '-'}</td>
                      <td className="text-2">{e.reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Drawer>
      <EditKeyModal
        k={editing ? k ?? null : null}
        onClose={() => setEditing(false)}
        onSaved={() => {
          reload();
          onChanged();
        }}
      />
      <ConfirmDialog
        open={action === 'deactivate'}
        title="Deactivate key?"
        message="Requests with this key are rejected until it is reactivated. Usage history is kept."
        confirmLabel="Deactivate"
        withReason
        onConfirm={doAction}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog open={action === 'reactivate'} title="Reactivate key?" message="The key will work again immediately." confirmLabel="Reactivate" withReason onConfirm={doAction} onClose={() => setAction(null)} />
      <ConfirmDialog
        open={action === 'regenerate'}
        title="Regenerate secret?"
        message="A new secret is issued for this key and the current secret stops working immediately. Settings and usage history are kept. The new secret is shown once."
        confirmLabel="Regenerate"
        withReason
        onConfirm={doAction}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog
        open={action === 'revoke'}
        title="Revoke key permanently?"
        danger
        message={
          <>
            <strong>This cannot be undone.</strong> The key stops working immediately and can never be reactivated or regenerated. The key record and its usage history are retained for audit.
          </>
        }
        confirmLabel="Revoke permanently"
        requireText="REVOKE"
        withReason
        reasonLabel="Reason (recorded in the audit log and notification)"
        onConfirm={doAction}
        onClose={() => setAction(null)}
      />
    </>
  );
}

// ---------------- Page ----------------
export default function Keys() {
  const { canEdit } = useAuth();
  const apps = useApps();
  const entities = useEntities();
  const [appId, setAppId] = useState('');
  const [entityId, setEntityId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const serverStatus = status; // server filters active/expired by expiry date
  const { data, error, loading, reload } = useApi<ApiKey[]>(`/api/admin/keys${qs({ appId, entityId, status: serverStatus, q })}`);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<KeySecretResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = data ?? [];
    if (status === 'expired') return all.filter((k) => k.expired && k.status !== 'revoked');
    if (status === 'active') return all.filter((k) => !k.expired);
    return all;
  }, [data, status]);

  const columns: Column<ApiKey>[] = [
    {
      key: 'name',
      header: 'Key',
      render: (k) => (
        <div>
          <div className="cell-title">{k.name}</div>
          <div className="cell-sub mono">{k.displayKey}</div>
        </div>
      ),
    },
    { key: 'appName', header: 'App' },
    { key: 'entityName', header: 'Entity', render: (k) => <div><div>{k.entityName ?? '-'}</div>{k.entityType && <div className="cell-sub">{k.entityType}</div>}</div> },
    { key: 'status', header: 'Status', render: (k) => <StatusBadge status={keyStatus(k)} />, sortValue: (k) => keyStatus(k) },
    {
      key: 'expiresAt',
      header: 'Expires',
      render: (k) =>
        k.expiresAt ? (
          <span title={fmtDate(k.expiresAt)} className={k.expired ? 'danger-text' : new Date(k.expiresAt).getTime() - Date.now() < 7 * 86400_000 ? 'warning-text' : undefined}>
            <CalendarClock size={12} /> {fmtRelative(k.expiresAt)}
          </span>
        ) : (
          <span className="muted">never</span>
        ),
      sortValue: (k) => (k.expiresAt ? new Date(k.expiresAt).getTime() : Number.MAX_SAFE_INTEGER),
    },
    { key: 'spend30d', header: 'Spend 30d', numeric: true, render: (k) => fmtUsd(k.spend30d ?? 0) },
    { key: 'requests30d', header: 'Requests 30d', numeric: true, render: (k) => fmtNum(k.requests30d ?? 0), hideSm: true },
    { key: 'lastUsedAt', header: 'Last used', hideSm: true, render: (k) => <span title={fmtDate(k.lastUsedAt)}>{fmtRelative(k.lastUsedAt)}</span>, sortValue: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt).getTime() : 0) },
  ];

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Relay keys authenticate clients on the /v1 API. Secrets are shown once at creation; keys are never deleted, only revoked."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Create key
            </button>
          )
        }
      />
      <div className="toolbar">
        <div className="input-icon search">
          <Search size={14} />
          <input className="input" placeholder="Search name or prefix…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="select" style={{ width: 170 }} value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="App">
          <option value="">All apps</option>
          {(apps.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 170 }} value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label="Entity">
          <option value="">All entities</option>
          {(entities.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 140 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </select>
      </div>
      <div className="card">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Loading />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(k) => k.id}
            onRowClick={(k) => setSelected(k.id)}
            selectedKey={selected}
            emptyTitle="No API keys"
            emptyText={canEdit ? 'Create a key to let an application call the gateway.' : undefined}
          />
        )}
      </div>
      <CreateKeyModal open={creating} onClose={() => setCreating(false)} onCreated={(r) => { setSecret(r); reload(); }} />
      <KeyDrawer id={selected} onClose={() => setSelected(null)} onChanged={reload} onSecret={setSecret} />
      <SecretModal secret={secret?.secret ?? null} keyName={secret?.key.name} onClose={() => setSecret(null)} />
    </>
  );
}
