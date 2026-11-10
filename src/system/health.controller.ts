import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { Store } from '../database/store';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly store: Store) {}

  /** Liveness: the process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the database is reachable. Used by Docker / Azure health checks. */
  @Get()
  async ready(@Res() res: Response) {
    const db = await this.store.ping();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', database: db ? 'up' : 'down' });
  }
}
