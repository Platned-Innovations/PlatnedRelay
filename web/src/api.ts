/**
 * Single API client for the Relay admin API.
 * - Same-origin cookies (httpOnly session) + double-submit CSRF header on mutations.
 * - Uniform error type carrying `{statusCode, message, code, issues}` from the server.
 * - 401 -> /login, 403 PASSWORD_CHANGE_REQUIRED -> /change-password, MFA_ENROLLMENT_REQUIRED -> /profile.
 */

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  issues?: ApiIssue[];
  constructor(status: number, message: string, code?: string, issues?: ApiIssue[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export type AuthRedirect = 'login' | 'change-password' | 'mfa';
type AuthHandler = (kind: AuthRedirect) => void;
let authHandler: AuthHandler | null = null;

/** Registered by the app shell so the client can route without a full reload. */
export function setAuthHandler(fn: AuthHandler | null) {
  authHandler = fn;
}

export function readCookie(name: string): string {
  const parts = document.cookie ? document.cookie.split('; ') : [];
  for (const p of parts) {
    const i = p.indexOf('=');
    if (p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return '';
}

export interface RequestOptions {
  /** Don't trigger auth redirects (used by login/public pages and the session probe). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

async function parseError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const message = (body && (typeof body.message === 'string' ? body.message : body.error?.message)) || res.statusText || `Request failed (${res.status})`;
  return new ApiError(res.status, message, body?.code ?? body?.error?.code, Array.isArray(body?.issues) ? body.issues : undefined);
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const mutating = !['GET', 'HEAD'].includes(method);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (mutating) {
    headers['x-csrf-token'] = readCookie('relay_csrf');
    cache.clear();
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Network error - is the Relay server reachable?');
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (!opts.noAuthRedirect && authHandler) {
      if (res.status === 401) authHandler('login');
      else if (res.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') authHandler('change-password');
      else if (res.status === 403 && err.code === 'MFA_ENROLLMENT_REQUIRED') authHandler('mfa');
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
  /** GET with a short in-memory cache (lookup lists). Any mutation clears the cache. */
  cached<T>(path: string, ttlMs = 30_000): Promise<T> {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = request<T>('GET', path).catch((e) => {
      cache.delete(path);
      throw e;
    });
    cache.set(path, { at: Date.now(), value });
    return value;
  },
  clearCache() {
    cache.clear();
  },
};

/** Builds a query string, skipping empty values. Arrays are comma-joined. */
export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(','));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
