// Formatting helpers: money, tokens, numbers, percentages, dates (local time).

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const usdSig = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const grouped = new Intl.NumberFormat('en-US');

/** USD with precision that never collapses small non-zero amounts to $0.00. */
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const a = Math.abs(v);
  if (a === 0) return '$0.00';
  if (a >= 1) return usd2.format(v);
  if (a >= 0.01) return usd4.format(v);
  if (a < 0.000001) return v < 0 ? '-<$0.000001' : '<$0.000001';
  return usdSig.format(v);
}

/** Price per 1M tokens: up to 4 decimals, no forced rounding to cents. */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (v === 0) return '$0';
  return '$' + Number(v.toFixed(4)).toString();
}

export function fmtTokens(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return Math.abs(v) < 1000 ? grouped.format(Math.round(v)) : compact.format(v);
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return compact.format(v);
}

/** Ratio (0..1) to percent. */
export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '-';
  const p = ratio * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p >= 10 ? Math.min(digits, 1) : digits)}%`;
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  if (v >= 10_000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.round(v)} ms`;
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '-';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTimeSec(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '-';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDay(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '-';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtRelative(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return 'never';
  const diff = (Date.now() - d.getTime()) / 1000;
  const fut = diff < 0;
  const s = Math.abs(diff);
  let out: string;
  if (s < 45) out = 'just now';
  else if (s < 3600) out = `${Math.round(s / 60)} min`;
  else if (s < 86400) out = `${Math.round(s / 3600)} h`;
  else if (s < 86400 * 45) out = `${Math.round(s / 86400)} d`;
  else return fmtDay(d);
  if (out === 'just now') return out;
  return fut ? `in ${out}` : `${out} ago`;
}

export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

/** Bucket label for charts based on bucket granularity. */
export function fmtBucket(iso: string, bucket?: string): string {
  const d = toDate(iso);
  if (!d) return iso;
  if (bucket === 'hour') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  if (bucket === 'month') return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** ISO -> value for <input type="datetime-local"> in local time. */
export function toLocalInput(v: string | Date | undefined | null): string {
  const d = toDate(v ?? null);
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "a, b\nc" -> ['a','b','c'] */
export function splitList(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Parses an optional integer input; '' -> undefined. */
export function optInt(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
export function optNum(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
export function numStr(n: number | undefined | null): string {
  return n === undefined || n === null ? '' : String(n);
}

export function randomId(len = 12): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
