import { useEffect, useState } from 'react';
import { Download, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useDebounced } from '../hooks';
import type { AuditRow, AuditVerify, Paged } from '../types';
import { Alert, Badge, CodeBlock, ErrorState, FormField, KV, Loading, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { DataTable, Pager, type Column } from '../components/DataTable';
import { Drawer } from '../components/Modal';
import { DateRangePicker, presetRange, type DateRange } from '../components/DateRangePicker';
import { fmtDateTimeSec, fmtNum } from '../format';

const RESOURCE_TYPES = ['user', 'api_key', 'app', 'entity', 'provider', 'model', 'route', 'guardrail', 'budget', 'prompt', 'settings'];

export default function Audit() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState<DateRange>(() => presetRange('30d'));
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);
  const a = useDebounced(action);
  const ac = useDebounced(actor);
  const filters = { from: range.from, to: range.to, action: a, actor: ac, resourceType, outcome };
  useEffect(() => setPage(1), [range, a, ac, resourceType, outcome]);
  const { data, error, loading, reload } = useApi<Paged<AuditRow>>(`/api/admin/audit${qs({ ...filters, page, pageSize: 50 })}`);
  const [sel, setSel] = useState<AuditRow | null>(null);
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const { busy, run } = useAction();

  const columns: Column<AuditRow>[] = [
    { key: 'seq', header: '#', numeric: true, render: (r) => <span className="muted">{r.seq}</span> },
    { key: 'ts', header: 'Time', render: (r) => <span className="nowrap">{fmtDateTimeSec(r.ts)}</span> },
    { key: 'actorName', header: 'Actor', render: (r) => <div><div>{r.actorName}</div><div className="cell-sub">{r.actorType}{r.ip ? ` · ${r.ip}` : ''}</div></div> },
    { key: 'action', header: 'Action', render: (r) => <code>{r.action}</code> },
    { key: 'resourceType', header: 'Resource', render: (r) => (r.resourceType ? <div><Badge>{r.resourceType}</Badge>{r.resourceId && <div className="cell-sub mono">{r.resourceId.slice(0, 12)}</div>}</div> : <span className="muted">-</span>) },
    { key: 'outcome', header: 'Outcome', render: (r) => <StatusBadge status={r.outcome} /> },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Tamper-evident record of every administrative action. Each entry is chained to the previous one with an HMAC so edits or deletions are detectable."
        actions={
          isAdmin && (
            <>
              <button className="btn" disabled={busy} onClick={() => run(async () => setVerify(await api.get<AuditVerify>('/api/admin/audit/verify')))}>
                {busy ? <Spinner size={14} /> : <ShieldCheck size={14} />} Verify integrity
              </button>
              <a className="btn" href={`/api/admin/audit/export.json${qs(filters)}`} download>
                <Download size={14} /> Export JSON
              </a>
            </>
          )
        }
      />
      {verify && (
        <div className="mb-2">
          {verify.ok ? (
            <Alert tone="success" title="Audit chain intact">
              {fmtNum(verify.checked)} entries verified; no gaps or modifications detected.
            </Alert>
          ) : (
            <Alert tone="danger" title="Audit chain broken">
              <ShieldAlert size={13} /> {verify.reason} at entry #{verify.brokenAt}. {fmtNum(verify.checked)} entries verified before the break. Investigate database access immediately.
            </Alert>
          )}
        </div>
      )}
      <div className="card mb-2">
        <div className="card-body">
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <FormField label="Date range">
              <DateRangePicker value={range} onChange={setRange} />
            </FormField>
            <FormField label="Action">
              <div className="input-icon">
                <Search size={14} />
                <input className="input input-sm" placeholder="e.g. key.revoked" value={action} onChange={(e) => setAction(e.target.value)} />
              </div>
            </FormField>
            <FormField label="Actor">
              <input className="input input-sm" placeholder="username" value={actor} onChange={(e) => setActor(e.target.value)} />
            </FormField>
            <FormField label="Resource type">
              <select className="select select-sm" value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
                <option value="">All</option>
                {RESOURCE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Outcome">
              <select className="select select-sm" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">All</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </select>
            </FormField>
          </div>
        </div>
      </div>
      <div className="card">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div style={{ opacity: loading ? 0.6 : 1 }}>
            <DataTable columns={columns} rows={data.rows} rowKey={(r) => r.id} onRowClick={setSel} selectedKey={sel?.id} emptyTitle="No audit entries match" compact />
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </div>
      <Drawer open={!!sel} onClose={() => setSel(null)} title={sel ? `#${sel.seq} ${sel.action}` : ''} wide headerExtra={sel && <StatusBadge status={sel.outcome} />}>
        {sel && (
          <>
            <KV
              items={[
                ['Time', fmtDateTimeSec(sel.ts)],
                ['Action', <code key="a">{sel.action}</code>],
                ['Actor', `${sel.actorName} (${sel.actorType}${sel.actorId && sel.actorId !== sel.actorName ? `, ${sel.actorId}` : ''})`],
                ['Resource', sel.resourceType ? `${sel.resourceType}${sel.resourceId ? ` / ${sel.resourceId}` : ''}` : undefined],
                ['Outcome', sel.outcome],
                ['IP', sel.ip],
                ['User agent', sel.userAgent && <span className="small">{sel.userAgent}</span>],
                ['Key ID', sel.kid && <code>{sel.kid}</code>],
                ['Hash', <code key="h" className="small" style={{ wordBreak: 'break-all' }}>{sel.hash}</code>],
                ['Previous hash', <code key="p" className="small" style={{ wordBreak: 'break-all' }}>{sel.prevHash}</code>],
              ]}
            />
            <div className="section-title mt-3">Details</div>
            {sel.details !== undefined ? <CodeBlock code={JSON.stringify(sel.details, null, 2)} /> : <p className="muted">No details recorded.</p>}
          </>
        )}
      </Drawer>
    </>
  );
}
