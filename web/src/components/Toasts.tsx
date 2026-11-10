import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { ApiError, type ApiIssue } from '../api';

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  issues?: ApiIssue[];
}

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

function push(kind: ToastKind, title: string, issues?: ApiIssue[], ttl?: number) {
  const id = ++seq;
  items = [...items.slice(-4), { id, kind, title, issues }];
  emit();
  const life = ttl ?? (kind === 'error' ? 8000 : 4000);
  window.setTimeout(() => dismiss(id), life);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (title: string) => push('success', title),
  info: (title: string) => push('info', title),
  error: (e: unknown) => {
    if (e instanceof ApiError) push('error', e.message, e.issues);
    else if (e instanceof Error) {
      if (e.name === 'AbortError') return;
      push('error', e.message);
    } else push('error', String(e));
  },
};

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={17} /> : t.kind === 'error' ? <AlertCircle size={17} /> : <Info size={17} />}
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.issues && t.issues.length > 0 && (
              <ul>
                {t.issues.map((i, n) => (
                  <li key={n}>
                    {i.path ? <strong>{i.path}: </strong> : null}
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
