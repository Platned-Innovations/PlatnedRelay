import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, Coins, Database, DollarSign, PiggyBank, Zap } from 'lucide-react';
import { qs } from '../api';
import { useApi, useApps } from '../hooks';
import type { Overview, TopRow } from '../types';
import { Card, ErrorState, Loading, PageHeader, StatCard, Tabs, Empty } from '../components/ui';
import { DateRangePicker, presetRange, type DateRange } from '../components/DateRangePicker';
import { RankBarChart, TimeAreaChart, TimeStackChart } from '../components/charts';
import { fmtCompact, fmtMs, fmtNum, fmtPct, fmtTokens, fmtUsd } from '../format';

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span className="muted">{cur ? 'no data in previous period' : 'vs previous period'}</span>;
  const ch = (cur - prev) / prev;
  const up = ch >= 0;
  return (
    <span title="Change vs previous period of equal length">
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {up ? '+' : ''}
      {(ch * 100).toFixed(1)}% vs previous
    </span>
  );
}

export function RankedList({ rows, valueKey = 'costUsd', format = fmtUsd, sub }: { rows: TopRow[]; valueKey?: keyof TopRow; format?: (v: number) => string; sub?: (r: TopRow) => string }) {
  if (!rows.length) return <Empty title="No usage in this range" />;
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 0) || 1;
  return (
    <ul className="ranked">
      {rows.map((r) => (
        <li key={String(r.id) + r.name}>
          <span className="name" title={r.name}>
            {r.name}
            {sub && <span className="cell-sub"> · {sub(r)}</span>}
          </span>
          <strong className="num">{format(Number(r[valueKey]) || 0)}</strong>
          <div className="bar">
            <span style={{ width: `${((Number(r[valueKey]) || 0) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

type TopDim = 'apps' | 'models' | 'providers' | 'entities' | 'keys';

export default function Dashboard() {
  const [range, setRange] = useState<DateRange>(() => presetRange('7d'));
  const [appId, setAppId] = useState('');
  const [topDim, setTopDim] = useState<TopDim>('models');
  const apps = useApps();
  const { data, error, loading, reload } = useApi<Overview>(`/api/admin/analytics/overview${qs({ from: range.from, to: range.to, appId })}`);

  const series = useMemo(() => (data?.series ?? []).map((s) => ({ ...s, ok: Math.max(0, (s.requests ?? 0) - (s.errors ?? 0)) })), [data]);
  const t = data?.totals ?? {};
  const prev = data?.previous ?? { costUsd: 0, requests: 0 };

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Spend, traffic and reliability across all gateway traffic."
        actions={
          <>
            <select className="select select-sm" style={{ width: 180 }} value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="App filter">
              <option value="">All apps</option>
              {(apps.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <DateRangePicker value={range} onChange={setRange} />
          </>
        }
      />
      {error ? (
        <div className="card">
          <ErrorState error={error} onRetry={reload} />
        </div>
      ) : !data && loading ? (
        <Loading />
      ) : data ? (
        <div className="stack" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
          <div className="stats">
            <StatCard label="Spend" icon={<DollarSign size={13} />} value={fmtUsd(t.costUsd ?? 0)} sub={<Delta cur={t.costUsd ?? 0} prev={prev.costUsd} />} />
            <StatCard label="Requests" icon={<Activity size={13} />} value={fmtNum(t.requests ?? 0)} sub={<Delta cur={t.requests ?? 0} prev={prev.requests} />} />
            <StatCard label="Tokens in" icon={<Coins size={13} />} value={fmtTokens(t.inputTokens ?? 0)} sub={<>{fmtTokens(t.cachedTokens ?? 0)} cached</>} title={fmtNum(t.inputTokens)} />
            <StatCard label="Tokens out" icon={<Coins size={13} />} value={fmtTokens(t.outputTokens ?? 0)} title={fmtNum(t.outputTokens)} sub={<>{fmtUsd(t.outputCostUsd ?? 0)} output cost</>} />
            <StatCard label="Error rate" icon={<AlertTriangle size={13} />} value={fmtPct(t.errorRate ?? 0)} sub={<>{fmtNum(t.errors ?? 0)} errors · {fmtNum(t.blocked ?? 0)} blocked</>} />
            <StatCard label="Cache hit rate" icon={<Database size={13} />} value={fmtPct(t.cacheHitRate ?? 0)} sub={<>{fmtNum(t.cacheHits ?? 0)} hits</>} />
            <StatCard label="Avg latency" icon={<Clock size={13} />} value={fmtMs(t.avgLatencyMs ?? 0)} sub={<>max {fmtMs(t.maxLatencyMs ?? 0)}</>} />
            <StatCard label="Saved by cache" icon={<PiggyBank size={13} />} value={fmtUsd(t.savedUsd ?? 0)} sub={<>avg {fmtUsd(t.requests ? (t.costUsd ?? 0) / t.requests : 0)} / request</>} />
          </div>

          <div className="grid grid-2">
            <Card title="Spend over time" actions={<span className="muted small">per {data.range.bucket}</span>}>
              {series.length ? <TimeAreaChart data={series} bucket={data.range.bucket} def={{ key: 'costUsd', label: 'Spend', format: fmtUsd }} /> : <Empty title="No usage in this range" />}
            </Card>
            <Card title="Requests & errors" actions={<span className="muted small">per {data.range.bucket}</span>}>
              {series.length ? (
                <TimeStackChart
                  data={series}
                  bucket={data.range.bucket}
                  defs={[
                    { key: 'ok', label: 'Succeeded', format: (v) => fmtNum(v) },
                    { key: 'errors', label: 'Errors', format: (v) => fmtNum(v) },
                  ]}
                  height={236}
                />
              ) : (
                <Empty title="No usage in this range" />
              )}
            </Card>
          </div>

          <div className="grid grid-2">
            <Card title="Top apps by spend" flush actions={<Link to="/reports" className="small">Open reports</Link>}>
              <div style={{ padding: '8px 8px 4px' }}>{data.top.apps.length ? <RankBarChart data={data.top.apps as unknown as Record<string, unknown>[]} valueKey="costUsd" /> : <Empty title="No usage in this range" />}</div>
            </Card>
            <Card title="Top models by spend" flush>
              <div style={{ padding: '8px 8px 4px' }}>{data.top.models.length ? <RankBarChart data={data.top.models as unknown as Record<string, unknown>[]} valueKey="costUsd" /> : <Empty title="No usage in this range" />}</div>
            </Card>
          </div>

          <Card
            title="Leaders by spend"
            flush
            actions={<span className="muted small">Top 10 · {fmtCompact(t.requests ?? 0)} requests total</span>}
          >
            <div style={{ padding: '0 14px' }}>
              <Tabs<TopDim>
                value={topDim}
                onChange={setTopDim}
                tabs={[
                  { id: 'models', label: 'Models' },
                  { id: 'providers', label: 'Providers' },
                  { id: 'apps', label: 'Apps' },
                  { id: 'entities', label: 'Entities' },
                  { id: 'keys', label: 'API keys' },
                ]}
              />
            </div>
            <RankedList rows={data.top[topDim]} sub={(r) => `${fmtNum(r.requests)} req · ${fmtTokens(r.inputTokens + r.outputTokens)} tokens${r.errors ? ` · ${r.errors} errors` : ''}`} />
          </Card>

          {data.statuses.length > 0 && (
            <Card title="Requests by outcome">
              <div className="row" style={{ gap: 18 }}>
                {data.statuses.map((s) => (
                  <div key={s.status}>
                    <div className="stat-label">
                      <Zap size={12} /> {s.status}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 650 }}>{fmtNum(s.requests)}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      ) : null}
    </>
  );
}
