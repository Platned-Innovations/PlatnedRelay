import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Store, Filter } from '../database/store';
import { C } from '../database/schema';
import { parseDateRange } from '../common/util';
import { AuditService } from './audit.service';
import { MinRole } from '../auth/decorators';

@Controller('api/admin/audit')
export class AuditController {
  constructor(private readonly store: Store, private readonly audit: AuditService) {}

  private filter(q: Record<string, string | undefined>): Filter {
    const { from, to } = parseDateRange(q.from, q.to, 90);
    const f: Filter = { ts: { $gte: from, $lte: to } };
    if (q.action) f.action = { $ilike: q.action };
    if (q.actor) f.actorName = { $ilike: q.actor };
    if (q.resourceType) f.resourceType = q.resourceType;
    if (q.resourceId) f.resourceId = q.resourceId;
    if (q.outcome) f.outcome = q.outcome;
    return f;
  }

  @Get()
  async list(@Query() q: Record<string, string | undefined>) {
    const filter = this.filter(q);
    const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 500);
    const page = Math.max(Number(q.page) || 1, 1);
    const [rows, total] = await Promise.all([this.store.find(C.audit, filter, { sort: { seq: -1 }, limit: pageSize, skip: (page - 1) * pageSize }), this.store.count(C.audit, filter)]);
    return { page, pageSize, total, rows };
  }

  @MinRole('admin')
  @Get('verify')
  verify() {
    return this.audit.verify();
  }

  @MinRole('admin')
  @Get('export.json')
  async export(@Query() q: Record<string, string | undefined>, @Res() res: Response) {
    const rows = await this.store.find(C.audit, this.filter(q), { sort: { seq: 1 }, limit: 100_000 });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="relay-audit-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(rows, null, 1));
  }
}
