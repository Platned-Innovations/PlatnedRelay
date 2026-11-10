import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { qs } from '../api';
import { useApi, useApps, useEntities, useModels, useProviders } from '../hooks';
import type { ApiKey, Report, ReportRow } from '../types';
import { Card, ErrorState, FormField, Loading, PageHeader, Empty } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { DateRangePicker, presetRange, type DateRange } from '../components/DateRangePicker';
import { RankBarChart, TimeAreaChart } from '../components/charts';
import { fmtBucket, fmtMs, fmtNum, fmtPct, fmtTokens, fmtUsd } from '../format';

const DIMS: { id: string; label: string }[] = [
  { id: 'appId', label: 'App' },
  { id: 'entityId', label: 'Entity' },
  { id: 'keyId', label: 'API key' },
  { id: 'providerId', label: 'Provider' },
  { id: 'modelId', label: 'Model' },
  { id: 'routeId', label: 'Route' },
  { id: 'status', label: 'Status' },
  { id: 'endpoint', label: 'Endpoint' },
  { id: 'endUser', label: 'End user' },
];
const nameKey = (g: string) => `${g.replace(/Id$/, '')}Name`;

export default function Reports() {
  const [range, setRange] = useState<DateRange>(() => presetRange('30d'));
  const [f, setF] = useState({ appId: '', entityId: '', keyId: '', providerId: '', modelId: '', status: '' });
  const [groupBy, setGroupBy] = useState<string[]>(['appId']);
  const [bucket, setBucket] = useState('');
  const apps = useApps();
  const entities = useEntities();
  const providers = useProviders();
  const models = useModels();
  const keys = useApi<ApiKey[]>('/api/admin/keys', { cached: true });

  const query = qs({ from: range.from, to: range.to, ...f, groupBy, bucket });
  const { data, error, loading, reload } = useApi<Report>(`/api/admin/analytics/report${query}`);
  const rows = data?.rows ?? [];

  const totals = useMemo(() => {
    const s = { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, errors: 0, cacheHits: 0, savedUsd: 0, lat: 0 };
    for (const r of rows) {
      s.requests += r.requests ?? 0;
      s.costUsd += r.costUsd ?? 0;
      s.inputTokens += r.inputTokens ?? 0;
      s.outputTokens += r.outputTokens ?? 0;
      s.errors += r.errors ?? 0;
      s.cacheHits += r.cacheHits ?? 0;
      s.savedUsd += r.savedUsd ?? 0;
      s.lat += (r.avgLatencyMs ?? 0) * (r.requests ?? 0);
    }
    return s;
  }, [rows]);

  const groupLabel = (r: ReportRow) => (data?.groupBy ?? []).map((g) => String(r[nameKey(g)] ?? r[g] ?? '(none)')).join(' · ') || 'All';

  const chartData = useMemo(() => {
    if (!data) return [];
    if (data.bucket) {
      const m = new Map<string, number>();
      for (const r of rows) m.set(String(r.bucket), (m.get(String(r.bucket)) ?? 0) + (r.costUsd ?? 0));
      return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, costUsd]) => ({ bucket, costUsd }));
    }
    return [...rows]
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
      .slice(0, 12)
      .map((r) => ({ name: groupLabel(r), costUsd: r.costUsd ?? 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rows]);

  const columns: Column<ReportRow>[] = [
    ...(data?.bucket
      ? [{ key: 'bucket', header: 'Period', render: (r: ReportRow) => fmtBucket(String(r.bucket), data.bucket), sortValue: (r: ReportRow) => String(r.bucket), footer: 'Total' } as Column<ReportRow>]
      : []),
    ...(data?.groupBy ?? []).map(
      (g, i): Column<ReportRow> => ({
        key: g,
        header: DIMS.find((d) => d.id === g)?.label ?? g,
        render: (r) => <span title={String(r[g] ?? '')}>{String(r[nameKey(g)] ?? r[g] ?? '(none)')}</span>,
        sortValue: (r) => String(r[nameKey(g)] ?? ''),
        footer: !data?.bucket && i === 0 ? 'Total' : undefined,
      }),
    ),
    { key: 'requests', header: 'Requests', numeric: true, render: (r) => fmtNum(r.requests), footer: fmtNum(totals.requests) },
    { key: 'costUsd', header: 'Spend', numeric: true, render: (r) => fmtUsd(r.costUsd), footer: fmtUsd(totals.costUsd) },
    { key: 'inputTokens', header: 'Tokens in', numeric: true, render: (r) => <span title={fmtNum(r.inputTokens)}>{fmtTokens(r.inputTokens)}</span>, footer: fmtTokens(totals.inputTokens) },
    { key: 'outputTokens', header: 'Tokens out', numeric: true, render: (r) => <span title={fmtNum(r.outputTokens)}>{fmtTokens(r.outputTokens)}</span>, footer: fmtTokens(totals.outputTokens) },
    { key: 'errors', header: 'Errors', numeric: true, render: (r) => fmtNum(r.errors), footer: fmtNum(totals.errors) },
    { key: 'errorRate', header: 'Error %', numeric: true, render: (r) => fmtPct(r.errorRate), footer: fmtPct(totals.requests ? totals.errors / totals.requests : 0), hideSm: true },
    { key: 'cacheHitRate', header: 'Cache %', numeric: true, render: (r) => fmtPct(r.cacheHitRate), footer: fmtPct(totals.requests ? totals.cacheHits / totals.requests : 0), hideSm: true },
    { key: 'avgLatencyMs', header: 'Avg latency', numeric: true, render: (r) => fmtMs(r.avgLatencyMs), footer: fmtMs(totals.requests ? totals.lat / totals.requests : 0), hideSm: true },
    { key: 'savedUsd', header: 'Saved', numeric: true, render: (r) => fmtUsd(r.savedUsd ?? 0), footer: fmtUsd(totals.savedUsd), hideSm: true },
  ];

  const sel = (key: keyof typeof f, label: string, opts: { value: string; label: string }[]) => (
    <FormField label={label}>
      <select className="select select-sm" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
        <option value="">All</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FormField>
  );

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Slice usage and spend by any combination of dimensions. Totals are computed over the rows shown."
        actions={
          <a className="btn" href={`/api/admin/analytics/report.csv${query}`} download>
            <Download size={14} /> Export CSV
          </a>
        }
      />
      <div className="card mb-2">
        <div className="card-body">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <FormField label="Date range">
              <DateRangePicker value={range} onChange={setRange} />
            </FormField>
          </div>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            {sel('appId', 'App', (apps.data ?? []).map((a) => ({ value: a.id, label: a.name })))}
            {sel('entityId', 'Entity', (entities.data ?? []).map((a) => ({ value: a.id, label: a.name })))}
            {sel('keyId', 'API key', (keys.data ?? []).map((a) => ({ value: a.id, label: `${a.name} (${a.displayKey})` })))}
            {sel('providerId', 'Provider', (providers.data ?? []).map((a) => ({ value: a.id, label: a.name })))}
            {sel('modelId', 'Model', (models.data ?? []).map((a) => ({ value: a.id, label: a.slug })))}
            {sel('status', 'Status', ['success', 'error', 'blocked', 'aborted'].map((s) => ({ value: s, label: s })))}
          </div>
          <div className="row top" style={{ gap: 20 }}>
            <FormField label="Group by">
              <div className="chips" style={{ gap: 10 }}>
                {DIMS.map((d) => (
                  <label key={d.id} className="check">
                    <input
                      type="checkbox"
                      checked={groupBy.includes(d.id)}
                      onChange={(e) => setGroupBy(e.target.checked ? [...groupBy, d.id] : groupBy.filter((x) => x !== d.id))}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            </FormField>
            <FormField label="Time bucket">
              <select className="select select-sm" value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ width: 140 }}>
                <option value="">None</option>
                <option value="hour">Hour</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </FormField>
          </div>
          {groupBy.length === 0 && <div className="hint mt-1">No dimensions selected: the server groups by app by default.</div>}
        </div>
      </div>

      {error ? (
        <div className="card">
          <ErrorState error={error} onRetry={reload} />
        </div>
      ) : !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ opacity: loading ? 0.6 : 1 }}>
          <Card title={data.bucket ? `Spend per ${data.bucket}` : 'Top groups by spend'}>
            {chartData.length === 0 ? (
              <Empty title="No usage matches these filters" />
            ) : data.bucket ? (
              <TimeAreaChart data={chartData} bucket={data.bucket} def={{ key: 'costUsd', label: 'Spend', format: fmtUsd }} />
            ) : (
              <RankBarChart data={chartData} valueKey="costUsd" />
            )}
          </Card>
          <Card title={`${rows.length.toLocaleString()} rows`} flush>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => JSON.stringify([r.bucket, ...(data.groupBy ?? []).map((g) => r[g])])}
              initialSort={data.bucket ? { key: 'bucket', dir: 'asc' } : { key: 'costUsd', dir: 'desc' }}
              emptyTitle="No usage matches these filters"
              showFooter
              compact
            />
          </Card>
        </div>
      )}
    </>
  );
}
