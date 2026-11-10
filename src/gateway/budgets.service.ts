import { Injectable, Logger } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { BudgetRow, BudgetScope, CatalogService } from '../catalog/catalog.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface SpendContext {
  appId: string;
  entityId: string;
  keyId: string;
  providerId: string;
  modelId: string;
}

interface CounterRow {
  id: string;
  budgetId: string;
  periodKey: string;
  spentUsd: number;
  requests: number;
  notified?: number[];
}

export function periodKey(period: BudgetRow['period'], d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  switch (period) {
    case 'daily':
      return `D:${y}-${m}-${day}`;
    case 'monthly':
      return `M:${y}-${m}`;
    case 'weekly': {
      // ISO-8601 week number
      const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
      const dow = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - dow);
      const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `W:${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    default:
      return 'T';
  }
}

export function budgetMatches(scope: BudgetScope, ctx: Partial<SpendContext>): boolean {
  return (Object.keys(scope) as (keyof BudgetScope)[]).every((k) => !scope[k] || scope[k] === ctx[k]);
}

const REFRESH_MS = 5_000;

/**
 * Spend caps at any combination of app / entity / key / provider / model scope,
 * per day / ISO week / month / lifetime. Counters are atomic upserts in the DB;
 * each instance keeps a short-lived local view so the pre-request check costs no
 * DB round-trip (multi-instance drift is bounded by the refresh interval).
 */
@Injectable()
export class BudgetsService {
  private readonly logger = new Logger('Budgets');
  private local = new Map<string, { at: number; spent: number }>();

  constructor(private readonly store: Store, private readonly catalog: CatalogService, private readonly notifications: NotificationsService) {}

  private async spent(b: BudgetRow): Promise<number> {
    const key = `${b.id}|${periodKey(b.period)}`;
    const hit = this.local.get(key);
    if (hit && Date.now() - hit.at < REFRESH_MS) return hit.spent;
    const row = await this.store.findOne<CounterRow>(C.budgetCounters, { budgetId: b.id, periodKey: periodKey(b.period) });
    const spent = row?.spentUsd ?? 0;
    this.local.set(key, { at: Date.now(), spent });
    return spent;
  }

  /** Returns the first blocking budget that is already exhausted for this target, if any. */
  async findExceeded(ctx: SpendContext): Promise<BudgetRow | undefined> {
    const snap = await this.catalog.snapshot();
    for (const b of snap.budgets) {
      if (b.action !== 'block' || !budgetMatches(b.scope, ctx)) continue;
      if ((await this.spent(b)) >= b.amountUsd) return b;
    }
    return undefined;
  }

  /** Records spend against every matching budget and fires threshold notifications. */
  async record(ctx: SpendContext, costUsd: number): Promise<void> {
    if (!(costUsd > 0)) return;
    const snap = await this.catalog.snapshot();
    const matching = snap.budgets.filter((b) => budgetMatches(b.scope, ctx));
    await Promise.all(
      matching.map(async (b) => {
        try {
          const pk = periodKey(b.period);
          const row = await this.store.incrementUnique<CounterRow>(
            C.budgetCounters,
            { budgetId: b.id, periodKey: pk },
            { spentUsd: costUsd, requests: 1 },
            { createdAt: new Date(), notified: [] },
            { updatedAt: new Date() },
          );
          this.local.set(`${b.id}|${pk}`, { at: Date.now(), spent: row.spentUsd });
          await this.checkThresholds(b, row, snap);
        } catch (e: any) {
          this.logger.error(`Budget ${b.id} update failed: ${e.message}`);
        }
      }),
    );
  }

  private async checkThresholds(b: BudgetRow, row: CounterRow, snap: Awaited<ReturnType<CatalogService['snapshot']>>) {
    const pct = (row.spentUsd / b.amountUsd) * 100;
    const notified = new Set(row.notified ?? []);
    const crossed = (b.thresholds ?? []).filter((t) => pct >= t && !notified.has(t));
    if (!crossed.length) return;
    const top = Math.max(...crossed);
    crossed.forEach((t) => notified.add(t));
    await this.store.update(C.budgetCounters, row.id, { notified: [...notified].sort((a, c) => a - c) });
    const scope = describeScope(b.scope, snap);
    const reached = top >= 100;
    const app = b.scope.appId ? snap.apps.get(b.scope.appId) : undefined;
    const ent = b.scope.entityId ? snap.entities.get(b.scope.entityId) : undefined;
    await this.notifications.notify({
      event: reached ? 'budget.reached' : 'budget.warning',
      subject: reached ? `Relay spend cap reached: ${b.name}` : `Relay spend cap at ${top}%: ${b.name}`,
      title: reached ? 'Spend cap reached' : `Spend cap ${top}% used`,
      lines: [
        `Budget "${b.name}" (${scope}) has used $${row.spentUsd.toFixed(4)} of $${b.amountUsd.toFixed(2)} for the ${b.period} period (${pct.toFixed(1)}%).`,
        reached ? (b.action === 'block' ? 'Further requests in this scope are now blocked until the period resets or the cap is raised.' : 'This cap is notify-only; requests continue.') : 'No action is required yet.',
      ],
      to: [...(b.notifyEmails ?? []), ...(app?.ownerEmail ? [app.ownerEmail] : []), ...(ent?.email ? [ent.email] : [])],
      includeAdmins: true,
      relatedId: b.id,
      data: { budgetId: b.id, spentUsd: row.spentUsd, amountUsd: b.amountUsd, percent: pct, period: b.period },
    });
  }

  async status(b: BudgetRow) {
    const pk = periodKey(b.period);
    const row = await this.store.findOne<CounterRow>(C.budgetCounters, { budgetId: b.id, periodKey: pk });
    const spent = row?.spentUsd ?? 0;
    return { periodKey: pk, spentUsd: spent, requests: row?.requests ?? 0, percent: b.amountUsd ? (spent / b.amountUsd) * 100 : 0, exceeded: spent >= b.amountUsd };
  }

  async reset(b: BudgetRow) {
    const pk = periodKey(b.period);
    await this.store.deleteMany(C.budgetCounters, { budgetId: b.id, periodKey: pk });
    this.local.delete(`${b.id}|${pk}`);
  }
}

export function describeScope(scope: BudgetScope, snap: Awaited<ReturnType<CatalogService['snapshot']>>): string {
  const parts: string[] = [];
  if (scope.appId) parts.push(`app ${snap.apps.get(scope.appId)?.name ?? scope.appId}`);
  if (scope.entityId) parts.push(`entity ${snap.entities.get(scope.entityId)?.name ?? scope.entityId}`);
  if (scope.keyId) parts.push(`key ${scope.keyId.slice(0, 8)}`);
  if (scope.providerId) parts.push(`provider ${snap.providers.get(scope.providerId)?.name ?? scope.providerId}`);
  if (scope.modelId) parts.push(`model ${snap.models.get(scope.modelId)?.slug ?? scope.modelId}`);
  return parts.length ? parts.join(', ') : 'global';
}
