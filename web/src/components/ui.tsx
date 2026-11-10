import { useState, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, Inbox, Info, Loader2, RefreshCw } from 'lucide-react';
import { ApiError, type ApiIssue } from '../api';
import { toast } from './Toasts';

// ---------- Badge ----------
export type Tone = 'neutral' | 'success' | 'danger' | 'warning' | 'info';
export function Badge({ tone = 'neutral', children, dot, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`badge${tone !== 'neutral' ? ` badge-${tone}` : ''}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  active: 'success',
  success: 'success',
  sent: 'success',
  ok: 'success',
  disabled: 'neutral',
  inactive: 'warning',
  invited: 'info',
  revoked: 'danger',
  expired: 'danger',
  error: 'danger',
  failed: 'danger',
  failure: 'danger',
  blocked: 'warning',
  aborted: 'neutral',
  locked: 'danger',
  skipped: 'neutral',
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} dot>
      {label ?? status}
    </Badge>
  );
}

// ---------- Loading / Error / Empty ----------
export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

export function Loading({ label = 'Loading…', full }: { label?: string; full?: boolean }) {
  return (
    <div className={`loading${full ? ' loading-full' : ''}`}>
      <Spinner /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  const issues = error instanceof ApiError ? error.issues : undefined;
  return (
    <div className="card-body">
      <Alert tone="danger" title="Could not load data">
        {msg}
        <IssueList issues={issues} />
        {onRetry && (
          <div className="mt-1">
            <button className="btn btn-sm" onClick={onRetry}>
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}
      </Alert>
    </div>
  );
}

export function IssueList({ issues }: { issues?: ApiIssue[] }) {
  if (!issues?.length) return null;
  return (
    <ul>
      {issues.map((i, n) => (
        <li key={n}>
          {i.path ? <strong>{i.path}: </strong> : null}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function Empty({ title = 'Nothing here yet', children, icon }: { title?: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={28} />}
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

// ---------- Alert ----------
export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode }) {
  const Icon = tone === 'danger' ? AlertCircle : tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={16} />
      <div className="grow">
        {title && <div style={{ fontWeight: 600, marginBottom: children ? 2 : 0 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// ---------- Form ----------
export function FormField({
  label,
  hint,
  error,
  required,
  children,
  className,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      {label && (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {required && <span className="req">*</span>}
        </label>
      )}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  id,
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <select id={id} className={`select${className ? ` ${className}` : ''}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------- Copy ----------
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export function CopyButton({ text, label, small, className }: { text: string; label?: string; small?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn${small ? ' btn-sm' : ''}${label ? '' : ' btn-icon'}${className ? ` ${className}` : ''}`}
      title="Copy to clipboard"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } else toast.error('Copy failed - select the text and copy manually');
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

export function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
  return (
    <div className="code-block">
      <pre className={wrap ? 'wrap' : undefined}>{code}</pre>
      <CopyButton text={code} small className="copy-abs" />
    </div>
  );
}

// ---------- Stat ----------
export function StatCard({ label, value, sub, icon, title }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ---------- Tabs ----------
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab${value === t.id ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Page header ----------
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="card-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Progress({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const cls = percent >= 100 ? ' over' : percent >= 80 ? ' warn' : '';
  return (
    <div className={`progress${cls}`} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${p}%` }} />
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v === undefined || v === null || v === '' ? <span className="muted">-</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}
