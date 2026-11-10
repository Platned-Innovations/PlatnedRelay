import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/** Searchable checkbox list (inline, works well inside modals). */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  disabled,
  height = 180,
  emptyText = 'No options',
}: {
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  height?: number;
  emptyText?: string;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter((o) => o.label.toLowerCase().includes(s) || o.value.toLowerCase().includes(s) || o.hint?.toLowerCase().includes(s));
  }, [options, q]);
  const set = new Set(value);
  const toggle = (v: string) => {
    if (disabled) return;
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(options.map((o) => o.value).filter((x) => next.has(x)).concat([...next].filter((x) => !options.some((o) => o.value === x))));
  };
  const unknown = value.filter((v) => !options.some((o) => o.value === v));
  return (
    <div className="ms" aria-disabled={disabled}>
      <div className="ms-head">
        <Search size={14} style={{ color: 'var(--text-3)', marginLeft: 4 }} />
        <input className="input" value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
        {!disabled && filtered.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...new Set([...value, ...filtered.map((o) => o.value)])])}>
            All
          </button>
        )}
        {!disabled && value.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      <div className="ms-list" style={{ maxHeight: height }}>
        {filtered.length === 0 && <div className="ms-empty">{options.length ? 'No matches' : emptyText}</div>}
        {filtered.map((o) => (
          <label key={o.value} className="ms-item">
            <input type="checkbox" checked={set.has(o.value)} disabled={disabled} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
            {o.hint && <span className="ms-hint">{o.hint}</span>}
          </label>
        ))}
        {unknown.map((v) => (
          <label key={v} className="ms-item">
            <input type="checkbox" checked disabled={disabled} onChange={() => toggle(v)} />
            <span className="muted">{v} (unknown)</span>
          </label>
        ))}
      </div>
      <div className="ms-foot">
        <span>{value.length} selected</span>
        <span>{options.length} available</span>
      </div>
    </div>
  );
}
