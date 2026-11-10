import { Injectable } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { MASK } from '../common/util';

export interface SecuritySettings {
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  requireMfa: boolean;
  /** CIDR/IP list allowed to reach the admin UI/API. Empty = any. */
  adminIpAllowlist: string[];
  /** Mask secrets in API responses even for owners. */
  inviteExpiryHours: number;
}

export interface GatewaySettings {
  publicBaseUrl: string;
  requestTimeoutMs: number;
  defaultMaxRetries: number;
  defaultCacheTtlSeconds: number;
  storeRequestBodies: boolean;
  requestLogRetentionDays: number;
  usageRetentionDays: number;
  auditRetentionDays: number;
  keyExpiryWarningDays: number[];
  maxRequestBodyMb: number;
  exposeCostHeaders: boolean;
  defaultKeyRpm: number;
}

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: string[];
  format: 'json' | 'slack' | 'teams';
  enabled: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  channel: 'none' | 'smtp' | 'graph';
  fromAddress: string;
  fromName: string;
  adminRecipients: string[];
  events: Record<string, boolean>;
  smtp: { host: string; port: number; secure: boolean; username: string; password?: string };
  graph: { tenantId: string; clientId: string; clientSecret?: string; senderUpn: string };
  webhooks: WebhookConfig[];
}

export interface RoutingSettings {
  /** Default classifier settings for the "auto" (cheap vs strong) strategy. */
  autoThresholdTokens: number;
  autoStrongKeywords: string[];
}

export const NOTIFICATION_EVENTS = [
  'user.onboarding',
  'user.password_reset',
  'budget.warning',
  'budget.reached',
  'key.created',
  'key.expiring',
  'key.revoked',
  'provider.failure',
  'security.alert',
] as const;

const DEFAULTS = {
  security: {
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 12,
    maxFailedLogins: 5,
    lockoutMinutes: 15,
    passwordMinLength: 12,
    requireMfa: false,
    adminIpAllowlist: [],
    inviteExpiryHours: 72,
  } as SecuritySettings,
  gateway: {
    publicBaseUrl: '',
    requestTimeoutMs: 120_000,
    defaultMaxRetries: 2,
    defaultCacheTtlSeconds: 3600,
    storeRequestBodies: false,
    requestLogRetentionDays: 30,
    usageRetentionDays: 730,
    auditRetentionDays: 2555,
    keyExpiryWarningDays: [14, 3, 1],
    maxRequestBodyMb: 10,
    exposeCostHeaders: true,
    defaultKeyRpm: 0,
  } as GatewaySettings,
  notifications: {
    enabled: false,
    channel: 'none',
    fromAddress: '',
    fromName: 'Relay LLM Gateway',
    adminRecipients: [],
    events: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, e !== 'key.created'])),
    smtp: { host: '', port: 587, secure: false, username: '' },
    graph: { tenantId: '', clientId: '', senderUpn: '' },
    webhooks: [],
  } as NotificationSettings,
  routing: { autoThresholdTokens: 2000, autoStrongKeywords: ['analyze', 'architecture', 'prove', 'step by step', 'complex', 'refactor', 'legal', 'reason'] } as RoutingSettings,
};

export type SettingsKey = keyof typeof DEFAULTS;
type SettingsMap = typeof DEFAULTS;

/** Paths (dot notation) holding secrets; stored encrypted and masked in API output. */
const SECRET_PATHS: Partial<Record<SettingsKey, string[]>> = {
  notifications: ['smtp.password', 'graph.clientSecret'],
};

function getPath(obj: any, path: string) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  if (value === undefined) delete o[keys[keys.length - 1]];
  else o[keys[keys.length - 1]] = value;
}

function merge<T>(defaults: T, value: Partial<T> | undefined): T {
  if (!value) return structuredClone(defaults);
  const out: any = structuredClone(defaults);
  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v as any);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

@Injectable()
export class SettingsService {
  private cache = new Map<string, { at: number; value: unknown }>();
  private static TTL = 5_000;

  constructor(private readonly store: Store, private readonly crypto: CryptoService) {}

  private ctx(key: string) {
    return `settings:${key}`;
  }

  /** Full settings including decrypted secrets. Internal use only. */
  async get<K extends SettingsKey>(key: K): Promise<SettingsMap[K]> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SettingsService.TTL) return hit.value as SettingsMap[K];
    const row = await this.store.findById<any>(C.settings, key);
    const value = merge(DEFAULTS[key], row?.value);
    if (row?.valueEnc) {
      const secrets = this.crypto.decryptJson<Record<string, string>>(row.valueEnc, this.ctx(key));
      for (const [p, v] of Object.entries(secrets)) setPath(value, p, v);
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Settings safe to return to the admin UI (secrets masked). */
  async getPublic<K extends SettingsKey>(key: K): Promise<SettingsMap[K] & { _secretsSet?: Record<string, boolean> }> {
    const value: any = structuredClone(await this.get(key));
    const set: Record<string, boolean> = {};
    for (const p of SECRET_PATHS[key] ?? []) {
      set[p] = !!getPath(value, p);
      setPath(value, p, getPath(value, p) ? MASK : '');
    }
    value._secretsSet = set;
    return value;
  }

  async update<K extends SettingsKey>(key: K, patch: Partial<SettingsMap[K]>, actorId: string): Promise<SettingsMap[K]> {
    const current: any = await this.get(key);
    const next: any = merge(current, patch as any);
    delete next._secretsSet;
    const secrets: Record<string, string> = {};
    for (const p of SECRET_PATHS[key] ?? []) {
      const incoming = getPath(patch, p);
      // Masked or omitted value means "keep the stored secret".
      const val = incoming === undefined || incoming === MASK ? getPath(current, p) : incoming;
      if (val) secrets[p] = val;
      setPath(next, p, undefined);
    }
    const doc = {
      value: next,
      valueEnc: Object.keys(secrets).length ? this.crypto.encryptJson(secrets, this.ctx(key)) : null,
      secret: Object.keys(secrets).length > 0,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    const existing = await this.store.findById(C.settings, key);
    if (existing) await this.store.update(C.settings, key, doc);
    else await this.store.insert(C.settings, { id: key, ...doc });
    this.cache.delete(key);
    return this.get(key);
  }

  /** Re-encrypt stored secrets with the current master key (after rotation). */
  async reEncrypt(): Promise<number> {
    let n = 0;
    for (const row of await this.store.find<any>(C.settings, { valueEnc: { $exists: true } })) {
      if (!this.crypto.needsReEncrypt(row.valueEnc)) continue;
      const plain = this.crypto.decrypt(row.valueEnc, this.ctx(row.id));
      await this.store.update(C.settings, row.id, { valueEnc: this.crypto.encrypt(plain, this.ctx(row.id)) });
      n++;
    }
    this.cache.clear();
    return n;
  }
}
