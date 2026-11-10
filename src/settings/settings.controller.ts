import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { Actor, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { CurrentActor, MinRole } from '../auth/decorators';
import { NOTIFICATION_EVENTS, SettingsKey, SettingsService } from './settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CatalogService, ProviderRow } from '../catalog/catalog.service';
import { CryptoService } from '../common/crypto.service';
import { ResponseCacheService } from '../gateway/response-cache.service';
import { loadEnv } from '../config/env';

const SCHEMAS: Record<SettingsKey, z.ZodTypeAny> = {
  security: z.object({
    sessionIdleMinutes: z.number().int().min(5).max(24 * 60),
    sessionAbsoluteHours: z.number().int().min(1).max(24 * 30),
    maxFailedLogins: z.number().int().min(3).max(50),
    lockoutMinutes: z.number().int().min(1).max(24 * 60),
    passwordMinLength: z.number().int().min(10).max(128),
    requireMfa: z.boolean(),
    adminIpAllowlist: z.array(z.string().regex(/^[0-9a-fA-F:.\/]+$/)).max(200),
    inviteExpiryHours: z.number().int().min(1).max(24 * 14),
  }).partial(),
  gateway: z.object({
    publicBaseUrl: z.string().url().or(z.literal('')),
    requestTimeoutMs: z.number().int().min(5_000).max(900_000),
    defaultMaxRetries: z.number().int().min(0).max(5),
    defaultCacheTtlSeconds: z.number().int().min(1).max(30 * 86400),
    storeRequestBodies: z.boolean(),
    requestLogRetentionDays: z.number().int().min(1).max(3650),
    usageRetentionDays: z.number().int().min(0).max(36500),
    auditRetentionDays: z.number().int().min(0).max(36500),
    keyExpiryWarningDays: z.array(z.number().int().min(1).max(365)).max(5),
    exposeCostHeaders: z.boolean(),
    defaultKeyRpm: z.number().int().min(0).max(1_000_000),
  }).partial(),
  routing: z.object({ autoThresholdTokens: z.number().int().min(1).max(10_000_000), autoStrongKeywords: z.array(z.string().max(100)).max(200) }).partial(),
  notifications: z.object({
    enabled: z.boolean(),
    channel: z.enum(['none', 'smtp', 'graph']),
    fromAddress: z.string().email().or(z.literal('')),
    fromName: z.string().max(100),
    adminRecipients: z.array(z.string().email()).max(100),
    events: z.record(z.enum(NOTIFICATION_EVENTS), z.boolean()),
    smtp: z.object({ host: z.string().max(255), port: z.number().int().min(1).max(65535), secure: z.boolean(), username: z.string().max(255), password: z.string().max(1000).optional() }).partial(),
    graph: z.object({ tenantId: z.string().max(100), clientId: z.string().max(100), clientSecret: z.string().max(1000).optional(), senderUpn: z.string().max(255) }).partial(),
    webhooks: z.array(z.object({ id: z.string().max(60), name: z.string().min(1).max(100), url: z.string().url().max(1000), events: z.array(z.string().max(60)).max(50), format: z.enum(['json', 'slack', 'teams']), enabled: z.boolean() })).max(20),
  }).partial(),
};

/** Security-sensitive settings require the owner role. */
const OWNER_ONLY: SettingsKey[] = ['security'];

@Controller('api/admin')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly store: Store,
    private readonly crypto: CryptoService,
    private readonly catalog: CatalogService,
    private readonly cache: ResponseCacheService,
  ) {}

  @Get('settings/:key')
  get(@Param('key') key: string) {
    if (!(key in SCHEMAS)) throw new BadRequestException('Unknown settings section');
    return this.settings.getPublic(key as SettingsKey);
  }

  @Put('settings/:key')
  async put(@Param('key') key: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    if (!(key in SCHEMAS)) throw new BadRequestException('Unknown settings section');
    const k = key as SettingsKey;
    if (OWNER_ONLY.includes(k) && actor.role !== 'owner') throw new BadRequestException('Only owners can change security settings');
    const parsed = new ZodPipe(SCHEMAS[k]).transform(body);
    const before = await this.settings.getPublic(k);
    await this.settings.update(k, parsed as any, actor.id);
    await this.audit.log(actor, { action: `settings.${k}.updated`, resourceType: 'settings', resourceId: k, details: { before, after: parsed } });
    return this.settings.getPublic(k);
  }

  @Post('notifications/test')
  @HttpCode(200)
  async testEmail(@Body(new ZodPipe(z.object({ to: z.string().email() }))) body: { to: string }, @CurrentActor() actor: Actor) {
    try {
      await this.notifications.sendTest(body.to);
      await this.audit.log(actor, { action: 'notifications.test_sent', details: { to: body.to } });
      return { ok: true };
    } catch (e: any) {
      await this.audit.log(actor, { action: 'notifications.test_sent', outcome: 'failure', details: { to: body.to, error: e.message } });
      return { ok: false, error: e.message };
    }
  }

  @Get('notifications/log')
  log(@Query('page') page?: string) {
    const p = Math.max(Number(page) || 1, 1);
    return this.store.find(C.notifications, {}, { sort: { ts: -1 }, limit: 100, skip: (p - 1) * 100 });
  }

  @Get('system/info')
  async info() {
    const env = loadEnv();
    const [users, apps, keys, providers, models] = await Promise.all([
      this.store.count(C.users), this.store.count(C.apps), this.store.count(C.apiKeys), this.store.count(C.providers), this.store.count(C.models),
    ]);
    const meta = await this.store.findById<any>(C.meta, 'install');
    return {
      version: process.env.npm_package_version || '1.0.0', node: process.version, database: this.store.kind, masterKeyId: this.crypto.keyId,
      rotationKeyLoaded: !!env.previousMasterKey, installedAt: meta?.value?.installedAt, uptimeSeconds: Math.round(process.uptime()),
      counts: { users, apps, keys, providers, models }, pid: process.pid,
    };
  }

  /** Re-encrypts every stored secret with the current master key (run after rotating RELAY_MASTER_KEY). */
  @MinRole('owner')
  @Post('system/reencrypt')
  @HttpCode(200)
  async reencrypt(@CurrentActor() actor: Actor) {
    let providers = 0;
    for (const p of await this.store.find<ProviderRow>(C.providers, { secretsEnc: { $exists: true } })) {
      if (!this.crypto.needsReEncrypt(p.secretsEnc!)) continue;
      const plain = this.crypto.decrypt(p.secretsEnc!, `provider:${p.id}:secrets`);
      await this.store.update(C.providers, p.id, { secretsEnc: this.crypto.encrypt(plain, `provider:${p.id}:secrets`) });
      providers++;
    }
    let users = 0;
    for (const u of await this.store.find<any>(C.users, { mfaSecretEnc: { $exists: true } })) {
      if (!this.crypto.needsReEncrypt(u.mfaSecretEnc)) continue;
      const plain = this.crypto.decrypt(u.mfaSecretEnc, `user:${u.id}:mfa`);
      await this.store.update(C.users, u.id, { mfaSecretEnc: this.crypto.encrypt(plain, `user:${u.id}:mfa`) });
      users++;
    }
    const settings = await this.settings.reEncrypt();
    const cache = await this.cache.purge();
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'system.reencrypted', details: { providers, users, settings, cachePurged: cache } });
    return {
      providers, users, settings, cachePurged: cache,
      note: 'Relay keys migrate to the new master key automatically on their next use while RELAY_MASTER_KEY_PREVIOUS is set; regenerate keys that were not used before removing it. Verify and export the audit log before removing the previous key. Stored request bodies encrypted with the old key expire with their retention window.',
    };
  }

  @Post('system/cache/purge')
  @HttpCode(200)
  async purgeCache(@Body() body: { appId?: string }, @CurrentActor() actor: Actor) {
    const n = await this.cache.purge(body?.appId);
    await this.audit.log(actor, { action: 'cache.purged', details: { appId: body?.appId, entries: n } });
    return { purged: n };
  }
}
