import { BadRequestException, Controller, Get, Injectable, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Store, Filter, MetricOp } from '../database/store';
import { C } from '../database/schema';
import { parseDateRange } from '../common/util';
import { CatalogService } from '../catalog/catalog.service';
import { UsageRecorder } from '../gateway/usage-recorder.service';
import { MinRole } from '../auth/decorators';

const DIMENSIONS = ['appId', 'entityId', 'keyId', 'providerId', 'modelId', 'routeId', 'status', 'endpoint', 'endUser', 'errorCode'] as const;
type Dim = (typeof DIMENSIONS)[number];

const METRICS: Record<string, MetricOp> = {
  requests: { op: 'count' },
  costUsd: { op: 'sum', field: 'costUsd' },
  inputCostUsd: { op: 'sum', field: 'inputCostUsd' },
  outputCostUsd: { op: 'sum', field: 'outputCostUsd' },
  savedUsd: { op: 'sum', field: 'savedUsd' },
  inputTokens: { op: 'sum', field: 'inputTokens' },
  outputTokens: { op: 'sum', field: 'outputTokens' },
  cachedTokens: { op: 'sum', field: 'cachedTokens' },
  errors: { op: 'countWhere', field: 'status', equals: 'error' },
  blocked: { op: 'countWhere', field: 'status', equals: 'blocked' },
  cacheHits: { op: 'countWhere', field: 'cacheHit', equals: true },
  avgLatencyMs: { op: 'avg', field: 'latencyMs' },
  maxLatencyMs: { op: 'max', field: 'latencyMs' },
};

export interface UsageFilters {
  from?: string; to?: string; appId?: string; entityId?: string; keyId?: string; providerId?: string; modelId?: string; status?: string; endpoint?: string;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly store: Store, private readonly catalog: CatalogService, private readonly recorder: UsageRecorder) {}

  filter(f: UsageFilters, defaultDays = 30): { filter: Filter; from: Date; to: Date } {
    const { from, to } = parseDateRange(f.from, f.to, defaultDays);
    const filter: Filter = { ts: { $gte: from, $lte: to } };
    for (const k of ['appId', 'entityId', 'keyId', 'providerId', 'modelId', 'status', 'endpoint'] as const) {
      const v = f[k];
      if (v) filter[k] = v.includes(',') ? { $in: v.split(',') } : v;
    }
    return { filter, from, to };
  }

  private async names() {
    const snap = await this.catalog.snapshot();
    const keys = new Map((await this.store.find<any>(C.apiKeys, {}, { limit: 100_000 })).map((k) => [k.id, `${k.name} (${k.prefix}…)`]));
    const routes = new Map([...snap.routesBySlug.values()].map((r) => [r.id, r.slug]));
    return {
      appId: (id: string) => snap.apps.get(id)?.name,
      entityId: (id: string) => snap.entities.get(id)?.name,
      keyId: (id: string) => keys.get(id),
      providerId: (id: string) => snap.providers.get(id)?.name,
      modelId: (id: string) => snap.models.get(id)?.slug,
      routeId: (id: string) => routes.get(id),
    } as Record<string, (id: string) => string | undefined>;
  }

  private withRates(r: Record<string, number>) {
    const req = r.requests || 0;
    return { ...r, errorRate: req ? (r.errors ?? 0) / req : 0, cacheHitRate: req ? (r.cacheHits ?? 0) / req : 0 };
  }

  async overview(f: UsageFilters) {
    const { filter, from, to } = this.filter(f);
    const span = to.getTime() - from.getTime();
    const prev = { ...filter, ts: { $gte: new Date(from.getTime() - span), $lt: from } };
    const bucket = span <= 2 * 86400_000 ? 'hour' : span > 180 * 86400_000 ? 'week' : 'day';
    const top = (dim: Dim) => this.store.aggregate(C.usage, { filter, groupBy: [dim], metrics: { costUsd: METRICS.costUsd, requests: METRICS.requests, inputTokens: METRICS.inputTokens, outputTokens: METRICS.outputTokens, errors: METRICS.errors }, sort: [{ key: 'costUsd', dir: -1 }], limit: 10 });
    const [totals, prevTotals, series, apps, models, providers, entities, keys, statuses, names] = await Promise.all([
      this.store.aggregate(C.usage, { filter, metrics: METRICS }),
      this.store.aggregate(C.usage, { filter: prev, metrics: { costUsd: METRICS.costUsd, requests: METRICS.requests } }),
      this.store.aggregate(C.usage, { filter, bucket: { field: 'ts', unit: bucket }, metrics: { costUsd: METRICS.costUsd, requests: METRICS.requests, errors: METRICS.errors, inputTokens: METRICS.inputTokens, outputTokens: METRICS.outputTokens, avgLatencyMs: METRICS.avgLatencyMs, cacheHits: METRICS.cacheHits }, sort: [{ key: 'bucket', dir: 1 }] }),
      top('appId'), top('modelId'), top('providerId'), top('entityId'), top('keyId'),
      this.store.aggregate(C.usage, { filter, groupBy: ['status'], metrics: { requests: METRICS.requests } }),
      this.names(),
    ]);
    const label = (dim: string, rows: any[]) => rows.map((r) => ({ ...r, id: r[dim], name: (r[dim] && names[dim]?.(r[dim])) || r[dim] || '(none)' }));
    return {
      range: { from, to, bucket },
      totals: this.withRates(totals[0] ?? {}),
      previous: prevTotals[0] ?? { costUsd: 0, requests: 0 },
      series,
      top: { apps: label('appId', apps), models: label('modelId', models), providers: label('providerId', providers), entities: label('entityId', entities), keys: label('keyId', keys) },
      statuses,
    };
  }

  async report(f: UsageFilters & { groupBy?: string; bucket?: string }) {
    const { filter, from, to } = this.filter(f);
    const groupBy = (f.groupBy ? f.groupBy.split(',') : ['appId']).filter(Boolean) as Dim[];
    if (groupBy.some((g) => !DIMENSIONS.includes(g))) throw new BadRequestException(`groupBy must be among: ${DIMENSIONS.join(', ')}`);
    const bucket = f.bucket && ['hour', 'day', 'week', 'month'].includes(f.bucket) ? (f.bucket as 'hour') : undefined;
    const [rows, names] = await Promise.all([
      this.store.aggregate(C.usage, { filter, groupBy, bucket: bucket ? { field: 'ts', unit: bucket } : undefined, metrics: METRICS, sort: bucket ? [{ key: 'bucket', dir: 1 }] : [{ key: 'costUsd', dir: -1 }], limit: 10_000 }),
      this.names(),
    ]);
    return {
      range: { from, to },
      groupBy,
      bucket,
      rows: rows.map((r) => {
        const out: Record<string, unknown> = this.withRates(r);
        for (const g of groupBy) out[`${g.replace(/Id$/, '')}Name`] = (r[g] && names[g]?.(r[g])) || r[g] || '(none)';
        return out;
      }),
    };
  }

  async logs(f: UsageFilters & { page?: string; pageSize?: string; q?: string }) {
    const { filter } = this.filter(f, 7);
    if (f.q) filter.$or = [{ requestId: { $ilike: f.q } }, { requestedModel: { $ilike: f.q } }, { errorMessage: { $ilike: f.q } }, { endUser: { $ilike: f.q } }];
    const pageSize = Math.min(Math.max(Number(f.pageSize) || 50, 1), 500);
    const page = Math.max(Number(f.page) || 1, 1);
    const [rows, total, names] = await Promise.all([
      this.store.find<any>(C.usage, filter, { sort: { ts: -1 }, limit: pageSize, skip: (page - 1) * pageSize }),
      this.store.count(C.usage, filter),
      this.names(),
    ]);
    return {
      page, pageSize, total,
      rows: rows.map((r) => ({ ...r, appName: names.appId(r.appId), entityName: names.entityId(r.entityId), keyName: names.keyId(r.keyId), providerName: r.providerId && names.providerId(r.providerId), modelSlug: r.modelId && names.modelId(r.modelId) })),
    };
  }

  async logBody(id: string) {
    const row = await this.store.findById<any>(C.requestLogs, id);
    if (!row) throw new NotFoundException('No stored body for this request (body logging disabled or expired)');
    return this.recorder.readBodies(row);
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }
}

@Controller('api/admin/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Query() q: UsageFilters) {
    return this.analytics.overview(q);
  }

  @Get('report')
  report(@Query() q: UsageFilters & { groupBy?: string; bucket?: string }) {
    return this.analytics.report(q);
  }

  @Get('report.csv')
  async reportCsv(@Query() q: UsageFilters & { groupBy?: string; bucket?: string }, @Res() res: Response) {
    const r = await this.analytics.report(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="relay-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(this.analytics.toCsv(r.rows as any));
  }

  @Get('logs')
  logs(@Query() q: UsageFilters & { page?: string; pageSize?: string; q?: string }) {
    return this.analytics.logs(q);
  }

  @Get('logs.csv')
  async logsCsv(@Query() q: UsageFilters & { q?: string }, @Res() res: Response) {
    const r = await this.analytics.logs({ ...q, pageSize: '500', page: '1' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="relay-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(this.analytics.toCsv(r.rows));
  }

  /** Stored prompt/response bodies are sensitive: admins only. */
  @MinRole('admin')
  @Get('logs/:id/body')
  body(@Param('id') id: string) {
    return this.analytics.logBody(id);
  }
}
