import { useEffect, useState } from 'react';
import { Pencil, Plus, Search } from 'lucide-react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useDebounced } from '../hooks';
import { ENTITY_TYPES, type Entity, type EntityType } from '../types';
import { Badge, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { fmtDate, titleCase } from '../format';

interface EntityForm {
  name: string;
  type: EntityType;
  email: string;
  description: string;
  status: 'active' | 'disabled';
}

function EntityModal({ entity, open, onClose, onSaved }: { entity?: Entity; open: boolean; onClose: () => void; onSaved: () => void }) {
  const init = (): EntityForm => ({ name: entity?.name ?? '', type: entity?.type ?? 'user', email: entity?.email ?? '', description: entity?.description ?? '', status: entity?.status ?? 'active' });
  const [f, setF] = useState<EntityForm>(init);
  const { busy, run } = useAction();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => open ? setF(init()) : undefined, [open, entity]);
  const save = () =>
    run(async () => {
      const body = { name: f.name.trim(), type: f.type, email: f.email.trim(), description: f.description.trim(), status: f.status };
      if (entity) await api.patch(`/api/admin/entities/${entity.id}`, body);
      else await api.post('/api/admin/entities', body);
      onSaved();
      onClose();
    }, entity ? 'Entity updated' : 'Entity created');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={entity ? `Edit entity: ${entity.name}` : 'New entity'}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !f.name.trim()}>
            {busy && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Name" required className="span-2">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={120} />
        </FormField>
        <FormField label="Type">
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as EntityType })}>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Status">
          <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as EntityForm['status'] })}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </FormField>
        <FormField label="Email" hint="Receives key and spend-cap notifications" className="span-2">
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </FormField>
        <FormField label="Description" className="span-2">
          <textarea className="textarea" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} />
        </FormField>
      </div>
    </Modal>
  );
}

export default function Entities() {
  const { canEdit } = useAuth();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const q = useDebounced(search);
  const { data, error, loading, reload } = useApi<Entity[]>(`/api/admin/entities${qs({ q })}`);
  const [edit, setEdit] = useState<{ entity?: Entity } | null>(null);
  const rows = (data ?? []).filter((e) => !type || e.type === type);

  const columns: Column<Entity>[] = [
    { key: 'name', header: 'Name', render: (e) => <div><div className="cell-title">{e.name}</div>{e.description && <div className="cell-sub truncate">{e.description}</div>}</div> },
    { key: 'type', header: 'Type', render: (e) => <Badge>{e.type}</Badge> },
    { key: 'email', header: 'Email' },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    { key: 'createdAt', header: 'Created', hideSm: true, render: (e) => fmtDate(e.createdAt) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (e) =>
        canEdit && (
          <button className="btn btn-sm" onClick={() => setEdit({ entity: e })}>
            <Pencil size={13} /> Edit
          </button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Entities"
        subtitle="Who or what a key belongs to: people, environments, services or teams. Usage and spend caps can be tracked per entity."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setEdit({})}>
              <Plus size={15} /> New entity
            </button>
          )
        }
      />
      <div className="toolbar">
        <div className="input-icon search">
          <Search size={14} />
          <input className="input" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="select" style={{ width: 160 }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {titleCase(t)}
            </option>
          ))}
        </select>
      </div>
      <div className="card">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={rows} rowKey={(e) => e.id} emptyTitle="No entities" initialSort={{ key: 'name', dir: 'asc' }} />}
      </div>
      <EntityModal open={!!edit} entity={edit?.entity} onClose={() => setEdit(null)} onSaved={reload} />
    </>
  );
}
