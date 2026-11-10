import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrentActor } from '../auth/decorators';
import { ApiKeyRow, AppRow, CatalogService, EntityRow } from '../catalog/catalog.service';

export const KEY_PREFIX = 'rly_';

const AccessSchema = z.object({
  mode: z.enum(['all', 'restricted']),
  providerIds: z.array(z.string()).max(200).default([]),
  modelIds: z.array(z.string()).max(1000).default([]),
  routeIds: z.array(z.string()).max(200).default([]),
});
const LimitsSchema = z.object({
  rpm: z.number().int().min(0).max(1_000_000).optional(),
  tpm: z.number().int().min(0).max(1_000_000_000).optional(),
  maxTokensPerRequest: z.number().int().min(0).max(10_000_000).optional(),
  maxConcurrent: z.number().int().min(0).max(100_000).optional(),
});
const IpListSchema = z.array(z.string().regex(/^[0-9a-fA-F:.\/]+$/, 'IP or CIDR')).max(100).default([]);
const CreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    appId: z.string().min(1),
    entityId: z.string().optional(),
    newEntity: z.object({ name: z.string().min(1).max(120), type: z.enum(['user', 'environment', 'service', 'team', 'other']), email: z.string().email().optional().or(z.literal('')) }).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    access: AccessSchema.default({ mode: 'all', providerIds: [], modelIds: [], routeIds: [] }),
    limits: LimitsSchema.default({}),
    ipAllowlist: IpListSchema,
    metadata: z.record(z.string(), z.string().max(500)).default({}),
    budget: z.object({ amountUsd: z.number().positive().max(10_000_000), period: z.enum(['daily', 'weekly', 'monthly', 'total']), action: z.enum(['block', 'notify']) }).optional(),
  })
  .refine((v) => v.entityId || v.newEntity, { message: 'entityId or newEntity is required' });
// Note: expiresAt, appId and entityId are immutable after creation by design.
const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  access: AccessSchema.optional(),
  limits: LimitsSchema.optional(),
  ipAllowlist: IpListSchema.optional(),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});
const ReasonSchema = z.object({ reason: z.string().max(500).optional() });

export function generateKeySecret() {
  return `${KEY_PREFIX}${CryptoService.randomToken(32)}`;
}

@Injectable()
export class KeysService {
  constructor(
    private readonly store: Store,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly notifications: NotificationsService,
  ) {}

  private hash(secret: string) {
    return this.crypto.hmac(`apikey:${secret}`);
  }

  private view(k: ApiKeyRow, apps?: Map<string, AppRow>, entities?: Map<string, EntityRow>) {
    const { keyHash, ...rest } = k;
    return {
      ...rest,
      displayKey: `${k.prefix}…${k.last4}`,
      expired: !!k.expiresAt && new Date(k.expiresAt) < new Date(),
      appName: apps?.get(k.appId)?.name,
      entityName: entities?.get(k.entityId)?.name,
      entityType: entities?.get(k.entityId)?.type,
    };
  }

  async list(f: { appId?: string; entityId?: string; status?: string; q?: string }) {
    const filter: Record<string, unknown> = {};
    if (f.appId) filter.appId = f.appId;
    if (f.entityId) filter.entityId = f.entityId;
    if (f.status === 'expired') Object.assign(filter, { expiresAt: { $lte: new Date() }, status: { $ne: 'revoked' } });
    else if (f.status === 'active') Object.assign(filter, { status: 'active', $and: [{ $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] }] });
    else if (f.status) filter.status = f.status;
    if (f.q) filter.$or = [{ name: { $ilike: f.q } }, { prefix: { $ilike: f.q } }];
    const [keys, snap, spend] = await Promise.all([
      this.store.find<ApiKeyRow>(C.apiKeys, filter, { sort: { createdAt: -1 }, limit: 2000 }),
      this.catalog.snapshot(),
      this.store.aggregate(C.usage, { filter: { ts: { $gte: new Date(Date.now() - 30 * 86400_000) } }, groupBy: ['keyId'], metrics: { cost: { op: 'sum', field: 'costUsd' }, requests: { op: 'count' } } }),
    ]);
    const s = new Map(spend.map((r) => [r.keyId, r]));
    return keys.map((k) => ({ ...this.view(k, snap.apps, snap.entities), spend30d: s.get(k.id)?.cost ?? 0, requests30d: s.get(k.id)?.requests ?? 0 }));
  }

  async get(id: string) {
    const k = await this.store.findById<ApiKeyRow>(C.apiKeys, id);
    if (!k) throw new NotFoundException('Key not found');
    return k;
  }

  async detail(id: string) {
    const [k, snap, events] = await Promise.all([this.get(id), this.catalog.snapshot(), this.store.find(C.keyEvents, { keyId: id }, { sort: { createdAt: -1 }, limit: 200 })]);
    return { ...this.view(k, snap.apps, snap.entities), events };
  }

  private async event(keyId: string, event: string, actor: Actor, reason?: string) {
    await this.store.insert(C.keyEvents, { id: CryptoService.id(), keyId, event, actorId: actor.id, actorName: actor.name, reason, createdAt: new Date() });
  }

  async create(input: z.infer<typeof CreateSchema>, actor: Actor) {
    const app = await this.store.findById<AppRow>(C.apps, input.appId);
    if (!app) throw new BadRequestException('App not found');
    let entityId = input.entityId;
    let entity: EntityRow | null = null;
    if (entityId) {
      entity = await this.store.findById<EntityRow>(C.entities, entityId);
      if (!entity) throw new BadRequestException('Entity not found');
    } else if (input.newEntity) {
      entity = {
        id: CryptoService.id(), name: input.newEntity.name, type: input.newEntity.type, email: input.newEntity.email || undefined,
        status: 'active', createdAt: new Date(), updatedAt: new Date(),
      };
      await this.store.insert(C.entities, entity);
      entityId = entity.id;
      await this.audit.log(actor, { action: 'entity.created', resourceType: 'entity', resourceId: entity.id, details: { name: entity.name } });
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (expiresAt && expiresAt <= new Date()) throw new BadRequestException('Expiry date must be in the future');
    const secret = generateKeySecret();
    const row: ApiKeyRow = {
      id: CryptoService.id(), name: input.name, appId: app.id, entityId: entityId!, keyHash: this.hash(secret),
      prefix: secret.slice(0, 12), last4: secret.slice(-4), status: 'active', expiresAt, access: input.access, limits: input.limits,
      ipAllowlist: input.ipAllowlist, metadata: input.metadata, createdBy: actor.id, rotationCount: 0, createdAt: new Date(), updatedAt: new Date(),
    };
    await this.store.insert(C.apiKeys, row);
    if (input.budget) {
      await this.store.insert(C.budgets, {
        id: CryptoService.id(), name: `Key: ${row.name}`, scope: { keyId: row.id }, period: input.budget.period, amountUsd: input.budget.amountUsd,
        action: input.budget.action, thresholds: [50, 80, 100], notifyEmails: entity?.email ? [entity.email] : [], status: 'active',
        createdBy: actor.id, createdAt: new Date(), updatedAt: new Date(),
      });
      this.catalog.invalidate();
    }
    await this.event(row.id, 'created', actor);
    await this.audit.log(actor, {
      action: 'key.created', resourceType: 'api_key', resourceId: row.id,
      details: { name: row.name, app: app.slug, entity: entity?.name, expiresAt, access: row.access, limits: row.limits, ipAllowlist: row.ipAllowlist },
    });
    await this.notifications.notify({
      event: 'key.created', subject: `Relay key created: ${row.name}`, title: 'A new Relay API key was created',
      lines: [`Key "${row.name}" (${row.prefix}…${row.last4}) was created for app ${app.name} / ${entity?.name} by ${actor.name}.`, expiresAt ? `Expires: ${expiresAt.toUTCString()}` : 'No expiry date.'],
      to: entity?.email ? [entity.email] : [], includeAdmins: true, relatedId: row.id,
    });
    return { key: this.view(row), secret };
  }

  async update(id: string, input: z.infer<typeof UpdateSchema>, actor: Actor) {
    const k = await this.get(id);
    if (k.status === 'revoked') throw new BadRequestException('Revoked keys cannot be modified');
    const updated = await this.store.update<ApiKeyRow>(C.apiKeys, id, { ...input, updatedAt: new Date() });
    this.catalog.invalidateKeys();
    await this.event(id, 'updated', actor);
    await this.audit.log(actor, { action: 'key.updated', resourceType: 'api_key', resourceId: id, details: { before: { name: k.name, access: k.access, limits: k.limits, ipAllowlist: k.ipAllowlist }, after: input } });
    return this.view(updated!);
  }

  async setStatus(id: string, action: 'deactivate' | 'reactivate' | 'revoke', reason: string | undefined, actor: Actor) {
    const k = await this.get(id);
    if (k.status === 'revoked') throw new BadRequestException('Key is permanently revoked');
    let patch: Record<string, unknown>;
    if (action === 'deactivate') {
      if (k.status !== 'active') throw new BadRequestException('Key is not active');
      patch = { status: 'inactive' };
    } else if (action === 'reactivate') {
      if (k.status !== 'inactive') throw new BadRequestException('Key is not inactive');
      if (k.expiresAt && new Date(k.expiresAt) < new Date()) throw new BadRequestException('Key has expired and cannot be reactivated');
      patch = { status: 'active' };
    } else {
      patch = { status: 'revoked', revokedAt: new Date(), revokedBy: actor.id, revokeReason: reason };
    }
    // Conditional update prevents racing state transitions.
    const updated = await this.store.updateWhere<ApiKeyRow>(C.apiKeys, id, { status: k.status }, { ...patch, updatedAt: new Date() });
    if (!updated) throw new BadRequestException('Key state changed concurrently, retry');
    this.catalog.invalidateKeys();
    const event = action === 'deactivate' ? 'deactivated' : action === 'reactivate' ? 'reactivated' : 'revoked';
    await this.event(id, event, actor, reason);
    await this.audit.log(actor, { action: `key.${event}`, resourceType: 'api_key', resourceId: id, details: { reason } });
    if (action === 'revoke') {
      const snap = await this.catalog.snapshot();
      const ent = snap.entities.get(k.entityId);
      await this.notifications.notify({
        event: 'key.revoked', subject: `Relay key revoked: ${k.name}`, title: 'A Relay API key was revoked',
        lines: [`Key "${k.name}" (${k.prefix}…${k.last4}) was permanently revoked by ${actor.name}.`, reason ? `Reason: ${reason}` : ''].filter(Boolean),
        to: ent?.email ? [ent.email] : [], includeAdmins: true, relatedId: id,
      });
    }
    return this.view(updated);
  }

  /** Issues a new secret for the same key record so historical usage stays linked. The old secret stops working immediately. */
  async regenerate(id: string, reason: string | undefined, actor: Actor) {
    const k = await this.get(id);
    if (k.status === 'revoked') throw new BadRequestException('Revoked keys cannot be regenerated');
    if (k.expiresAt && new Date(k.expiresAt) < new Date()) throw new BadRequestException('Expired keys cannot be regenerated');
    const secret = generateKeySecret();
    const updated = await this.store.update<ApiKeyRow>(C.apiKeys, id, {
      keyHash: this.hash(secret), prefix: secret.slice(0, 12), last4: secret.slice(-4), rotatedAt: new Date(), rotationCount: (k.rotationCount ?? 0) + 1, updatedAt: new Date(),
    });
    this.catalog.invalidateKeys();
    await this.event(id, 'regenerated', actor, reason);
    await this.audit.log(actor, { action: 'key.regenerated', resourceType: 'api_key', resourceId: id, details: { reason, previousPrefix: k.prefix } });
    return { key: this.view(updated!), secret };
  }
}

@Controller('api/admin/keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  list(@Query('appId') appId?: string, @Query('entityId') entityId?: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.keys.list({ appId, entityId, status, q });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.keys.detail(id);
  }

  @Post()
  create(@Body(new ZodPipe(CreateSchema)) body: z.infer<typeof CreateSchema>, @CurrentActor() actor: Actor) {
    return this.keys.create(body, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>, @CurrentActor() actor: Actor) {
    return this.keys.update(id, body, actor);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>, @CurrentActor() actor: Actor) {
    return this.keys.setStatus(id, 'deactivate', body.reason, actor);
  }

  @Post(':id/reactivate')
  reactivate(@Param('id') id: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>, @CurrentActor() actor: Actor) {
    return this.keys.setStatus(id, 'reactivate', body.reason, actor);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>, @CurrentActor() actor: Actor) {
    return this.keys.setStatus(id, 'revoke', body.reason, actor);
  }

  @Post(':id/regenerate')
  regenerate(@Param('id') id: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>, @CurrentActor() actor: Actor) {
    return this.keys.regenerate(id, body.reason, actor);
  }
}
