import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { Request } from 'express';
import { z, ZodSchema } from 'zod';

export interface Actor {
  type: 'user' | 'system' | 'apikey';
  id: string;
  name: string;
  role?: string;
  ip?: string;
  userAgent?: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'system', name: 'system' };

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const res = this.schema.safeParse(value);
    if (!res.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return res.data;
  }
}

export function clientIp(req: Request): string {
  // req.ip honours the "trust proxy" setting configured from TRUST_PROXY.
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

const SECRET_KEY_RE = /(pass(word)?|secret|token|api[-_]?key|authorization|credential|private)/i;

/** Deep copy with secret-looking keys masked; used for audit details and API responses. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) && v !== undefined && v !== null && v !== '' && typeof v !== 'boolean') out[k] = '[REDACTED]';
    else out[k] = redactSecrets(v, depth + 1);
  }
  return out as T;
}

/** Stable JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as object).filter((k) => (value as any)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(',')}}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function now(): Date {
  return new Date();
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function parseDateRange(from?: string, to?: string, defaultDays = 30): { from: Date; to: Date } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - defaultDays * 86400_000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new BadRequestException('Invalid date range');
  return { from: start, to: end };
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const MASK = '••••••••';

/** Drops null values (null means "clear" on PATCH but is meaningless on create). */
export function withoutNulls<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], null> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null)) as any;
}

/**
 * PATCH schema: every field optional and defaults removed. (zod 4 applies .default()
 * inside .partial(), which would silently reset omitted fields such as status.)
 */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodType<Partial<z.infer<z.ZodObject<T>>>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    shape[k] = (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : v).optional();
  }
  return z.object(shape) as unknown as z.ZodType<Partial<z.infer<z.ZodObject<T>>>>;
}
