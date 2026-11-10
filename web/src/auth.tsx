import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { Me, Role } from './types';

const RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

interface AuthCtx {
  user: Me | null;
  status: 'loading' | 'anon' | 'ready';
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
  /** Mutations allowed (admin or owner). */
  canEdit: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  hasRole: (r: Role) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthCtx['status']>('loading');

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<Me>('/api/admin/auth/me', { noAuthRedirect: true });
      setUser(me);
      setStatus('ready');
      return me;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setUser(null);
        setStatus('anon');
        return null;
      }
      // Network errors: treat as signed out but keep message visible on login page.
      setUser(null);
      setStatus('anon');
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/admin/auth/logout', {}, { noAuthRedirect: true });
    } catch {
      /* ignore */
    }
    api.clearCache();
    setUser(null);
    setStatus('anon');
  }, []);

  const value = useMemo<AuthCtx>(() => {
    const rank = user ? RANK[user.role] : 0;
    return {
      user,
      status,
      refresh,
      logout,
      canEdit: rank >= RANK.admin,
      isAdmin: rank >= RANK.admin,
      isOwner: rank >= RANK.owner,
      hasRole: (r: Role) => rank >= RANK[r],
    };
  }, [user, status, refresh, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
