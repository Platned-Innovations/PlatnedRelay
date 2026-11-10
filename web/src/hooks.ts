import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { toast } from './components/Toasts';
import type { App, Entity, Guardrail, Model, Provider, RouteRow } from './types';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (v: T | undefined) => void;
}

/** Fetches `path` (GET) whenever it changes. Pass null to skip. */
export function useApi<T>(path: string | null, opts: { cached?: boolean } = {}): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const cached = !!opts.cached;

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);
    (cached ? api.cached<T>(path) : api.get<T>(path, { signal: ctrl.signal }))
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive && (e as Error).name !== 'AbortError') setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [path, tick, cached]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Wraps an async action with a busy flag, toasting errors and optional success message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const run = useCallback(async <R,>(fn: () => Promise<R>, success?: string): Promise<R | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast.success(success);
      return r;
    } catch (e) {
      toast.error(e);
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, run };
}

// ---------- Lookup lists (cached) ----------
export const useApps = () => useApi<App[]>('/api/admin/apps', { cached: true });
export const useEntities = () => useApi<Entity[]>('/api/admin/entities', { cached: true });
export const useProviders = () => useApi<Provider[]>('/api/admin/providers', { cached: true });
export const useModels = () => useApi<Model[]>('/api/admin/models', { cached: true });
export const useRoutes = () => useApi<RouteRow[]>('/api/admin/routes', { cached: true });
export const useGuardrails = () => useApi<Guardrail[]>('/api/admin/guardrails', { cached: true });

export function useNameMap<T extends { id: string }>(rows: T[] | undefined, label: (r: T) => string) {
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) m.set(r.id, label(r));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}

/** State persisted to localStorage (per-viewer convenience only). */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}

/** Debounced value (for search inputs). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
