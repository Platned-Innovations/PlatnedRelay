import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as os from 'node:os';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiKeyRow, CatalogService } from '../catalog/catalog.service';

const INTERVAL_MS = 10 * 60_000;
const LOCK_ID = 'lock:maintenance';

/**
 * Periodic housekeeping: data retention, expired cache/sessions, key-expiry
 * warnings. Uses a DB lease so only one instance runs it in a scaled-out deployment.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Maintenance');
  private timer?: NodeJS.Timeout;
  private readonly holder = `${os.hostname()}:${process.pid}:${CryptoService.id().slice(0, 8)}`;

  constructor(
    private readonly store: Store,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly catalog: CatalogService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.tick(), 30_000).unref();
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  private async acquireLease(): Promise<boolean> {
    const now = new Date();
    const stale = new Date(now.getTime() - INTERVAL_MS + 30_000);
    try {
      const existing = await this.store.findById(C.meta, LOCK_ID);
      if (!existing) {
        await this.store.insert(C.meta, { id: LOCK_ID, value: { holder: this.holder }, updatedAt: now });
        return true;
      }
      const won = await this.store.updateWhere(C.meta, LOCK_ID, { updatedAt: { $lt: stale } }, { value: { holder: this.holder }, updatedAt: now });
      return !!won;
    } catch {
      return false;
    }
  }

  async tick() {
    if (!(await this.acquireLease())) return;
    try {
      const gw = await this.settings.get('gateway');
      const day = 86400_000;
      const now = Date.now();
      const results: Record<string, number> = {};
      results.cache = await this.store.deleteMany(C.cache, { expiresAt: { $lt: new Date() } });
      results.requestLogs = await this.store.deleteMany(C.requestLogs, { expiresAt: { $lt: new Date() } });
      results.sessions = await this.store.deleteMany(C.sessions, { expiresAt: { $lt: new Date(now - day) } });
      if (gw.usageRetentionDays > 0) results.usage = await this.store.deleteMany(C.usage, { ts: { $lt: new Date(now - gw.usageRetentionDays * day) } });
      if (gw.auditRetentionDays > 0) results.audit = await this.store.deleteMany(C.audit, { ts: { $lt: new Date(now - gw.auditRetentionDays * day) } });
      results.notifications = await this.store.deleteMany(C.notifications, { ts: { $lt: new Date(now - 180 * day) } });
      await this.keyExpiryWarnings(gw.keyExpiryWarningDays);
      if (Object.values(results).some((n) => n > 0)) this.logger.log(`Retention cleanup: ${JSON.stringify(results)}`);
    } catch (e: any) {
      this.logger.error(`Maintenance failed: ${e.message}`);
    }
  }

  private async keyExpiryWarnings(days: number[]) {
    if (!days.length) return;
    const maxDays = Math.max(...days);
    const keys = await this.store.find<ApiKeyRow>(C.apiKeys, { status: 'active', expiresAt: { $gt: new Date(), $lte: new Date(Date.now() + maxDays * 86400_000) } });
    if (!keys.length) return;
    const snap = await this.catalog.snapshot();
    for (const k of keys) {
      const left = (new Date(k.expiresAt!).getTime() - Date.now()) / 86400_000;
      const threshold = [...days].sort((a, b) => a - b).find((d) => left <= d);
      if (!threshold) continue;
      const event = `expiry_notice_${threshold}d`;
      if (await this.store.findOne(C.keyEvents, { keyId: k.id, event })) continue;
      await this.store.insert(C.keyEvents, { id: CryptoService.id(), keyId: k.id, event, actorId: 'system', actorName: 'system', createdAt: new Date() });
      const app = snap.apps.get(k.appId);
      const ent = snap.entities.get(k.entityId);
      await this.notifications.notify({
        event: 'key.expiring',
        subject: `Relay key "${k.name}" expires in ${Math.ceil(left)} day(s)`,
        title: 'API key expiring soon',
        lines: [
          `The key "${k.name}" (${k.prefix}…${k.last4}) for ${app?.name ?? 'unknown app'} / ${ent?.name ?? 'unknown entity'} expires on ${new Date(k.expiresAt!).toUTCString()}.`,
          'Expiry dates cannot be extended. Ask an administrator to issue a new key before it expires.',
        ],
        to: [...(ent?.email ? [ent.email] : []), ...(app?.ownerEmail ? [app.ownerEmail] : [])],
        includeAdmins: true,
        relatedId: k.id,
      });
    }
  }
}
