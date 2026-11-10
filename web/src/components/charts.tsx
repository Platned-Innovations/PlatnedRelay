import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { useChartTheme } from '../theme';
import { fmtBucket, fmtCompact, fmtUsd } from '../format';

export interface SeriesDef {
  key: string;
  label: string;
  format: (v: number) => string;
}

function TooltipBox({ active, payload, label, title, defs, colors }: TooltipProps<number, string> & { title: (l: unknown) => string; defs: SeriesDef[]; colors: string[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as Record<string, number>;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{title(label)}</div>
      {defs.map((d, i) => (
        <div className="tt-row" key={d.key}>
          <span>
            <i style={{ background: colors[i] }} />
            {d.label}
          </span>
          <strong>{d.format(Number(row[d.key] ?? 0))}</strong>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="chart-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Single-series area over time (e.g. spend). */
export function TimeAreaChart({ data, bucket, def, height = 260 }: { data: Record<string, unknown>[]; bucket?: string; def: SeriesDef; height?: number }) {
  const t = useChartTheme();
  const color = t.series[0];
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={t.grid} vertical={false} />
          <XAxis dataKey="bucket" tickFormatter={(v) => fmtBucket(String(v), bucket)} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={24} />
          <YAxis tickFormatter={(v) => def.format(Number(v))} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} width={64} />
          <Tooltip cursor={{ stroke: t.axis, strokeDasharray: '3 3' }} content={<TooltipBox title={(l) => fmtBucket(String(l), bucket)} defs={[def]} colors={[color]} />} />
          <Area isAnimationActive={false} type="monotone" dataKey={def.key} stroke={color} strokeWidth={2} fill="url(#areaFill)" dot={data.length <= 2 ? { r: 4, fill: color, stroke: t.surface, strokeWidth: 2 } : false} activeDot={{ r: 4, stroke: t.surface, strokeWidth: 2 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Stacked bars over time (e.g. successful + failed requests). Same unit, one axis. */
export function TimeStackChart({ data, bucket, defs, height = 260 }: { data: Record<string, unknown>[]; bucket?: string; defs: SeriesDef[]; height?: number }) {
  const t = useChartTheme();
  const colors = defs.map((_, i) => t.series[i]);
  return (
    <>
      <Legend items={defs.map((d, i) => ({ label: d.label, color: colors[i] }))} />
      <div className="chart-box" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid stroke={t.grid} vertical={false} />
            <XAxis dataKey="bucket" tickFormatter={(v) => fmtBucket(String(v), bucket)} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={24} />
            <YAxis tickFormatter={(v) => fmtCompact(Number(v))} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
            <Tooltip cursor={{ fill: t.cursor }} content={<TooltipBox title={(l) => fmtBucket(String(l), bucket)} defs={defs} colors={colors} />} />
            {defs.map((d, i) => (
              <Bar isAnimationActive={false} key={d.key} dataKey={d.key} stackId="s" fill={colors[i]} stroke={t.surface} strokeWidth={1} radius={i === defs.length - 1 ? [3, 3, 0, 0] : 0} maxBarSize={36} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/** Horizontal ranked bars (top N by a metric). */
export function RankBarChart({ data, valueKey, nameKey = 'name', format = fmtUsd, height }: { data: Record<string, unknown>[]; valueKey: string; nameKey?: string; format?: (v: number) => string; height?: number }) {
  const t = useChartTheme();
  const h = height ?? Math.max(120, data.length * 30 + 20);
  return (
    <div className="chart-box" style={{ height: h }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }} barCategoryGap="25%">
          <CartesianGrid stroke={t.grid} horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => format(Number(v))} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey={nameKey} width={150} stroke={t.axis} tick={{ fontSize: 11.5, fill: t.axis }} tickLine={false} axisLine={false} tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)} />
          <Tooltip cursor={{ fill: t.cursor }} content={<TooltipBox title={(l) => String(l)} defs={[{ key: valueKey, label: 'Value', format }]} colors={[t.series[0]]} />} />
          <Bar isAnimationActive={false} dataKey={valueKey} fill={t.series[0]} radius={[0, 3, 3, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
