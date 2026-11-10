import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, patchSchema, slugify, withoutNulls, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { CurrentActor } from '../auth/decorators';
import { AppRow, CatalogService, EntityRow } from '../catalog/catalog.service';

const AppSettingsSchema = z.object({
  cacheEnabled: z.boolean().optional(),
  cacheTtlSeconds: z.number().int().min(1).max(30 * 86400).nullable().optional(),
  logBodies: z.boolean().nullable().optional(),
  guardrailPolicyIds: z.array(z.string()).max(20).optional(),
  allowedModelIds: z.array(z.string()).max(500).optional(),
  defaultModel: z.string().max(200).nullable().optional(),
  rpm: z.number().int().min(0).max(1_000_000).nullable().optional(),
});
const AppSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  owner: z.string().max(120).optional(),
  ownerEmail: z.string().email().max(200).optional().or(z.literal('')),
  status: z.enum(['active', 'disabled']).default('active'),
  settings: AppSettingsSchema.default({}),
  tags: z.array(z.string().max(40)).max(20).default([]),
});
const EntitySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['user', 'environment', 'service', 'team', 'other']).default('user'),
  email: z.string().email().max(200).optional().or(z.literal('')),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
});

@Injectable()
export class AppsService {
  constructor(private readonly store: Store, private readonly audit: AuditService, private readonly catalog: CatalogService) {}

  async listApps() {
    const [apps, keyCounts] = await Promise.all([
      this.store.find<AppRow>(C.apps, {}, { sort: { name: 1 } }),
      this.store.aggregate(C.apiKeys, { groupBy: ['appId', 'status'], metrics: { n: { op: 'count' } } }),
    ]);
    return apps.map((a) => ({
      ...a,
      activeKeys: keyCounts.filter((k) => k.appId === a.id && k.status === 'active').reduce((s, k) => s + k.n, 0),
      totalKeys: keyCounts.filter((k) => k.appId === a.id).reduce((s, k) => s + k.n, 0),
    }));
  }

  async createApp(input: z.infer<typeof AppSchema>, actor: Actor) {
    const slug = slugify(input.slug || input.name).replace(/[/.]/g, '-');
    if (await this.store.findOne(C.apps, { slug })) throw new BadRequestException(`App "${slug}" already exists`);
    const row: AppRow = { id: CryptoService.id(), ...input, settings: withoutNulls(input.settings), ownerEmail: input.ownerEmail || undefined, slug, createdAt: new Date(), updatedAt: new Date() };
    await this.store.insert(C.apps, row);
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'app.created', resourceType: 'app', resourceId: row.id, details: { name: row.name, slug } });
    return row;
  }

  async updateApp(id: string, input: Partial<z.infer<typeof AppSchema>>, actor: Actor) {
    const app = await this.store.findById<AppRow>(C.apps, id);
    if (!app) throw new NotFoundException('App not found');
    const patch: Record<string, unknown> = { ...input, updatedAt: new Date() };
    delete patch.slug;
    // null clears a setting so it inherits the global default again
    if (input.settings) patch.settings = Object.fromEntries(Object.entries({ ...(app.settings ?? {}), ...input.settings }).filter(([, v]) => v !== null));
    const updated = await this.store.update<AppRow>(C.apps, id, patch);
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'app.updated', resourceType: 'app', resourceId: id, details: { before: app, after: input } });
    return updated;
  }

  listEntities(q?: string) {
    return this.store.find<EntityRow>(C.entities, q ? { name: { $ilike: q } } : {}, { sort: { name: 1 }, limit: 1000 });
  }

  async createEntity(input: z.infer<typeof EntitySchema>, actor: Actor) {
    const row: EntityRow = { id: CryptoService.id(), ...input, email: input.email || undefined, createdAt: new Date(), updatedAt: new Date() };
    await this.store.insert(C.entities, row);
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'entity.created', resourceType: 'entity', resourceId: row.id, details: { name: row.name, type: row.type } });
    return row;
  }

  async updateEntity(id: string, input: Partial<z.infer<typeof EntitySchema>>, actor: Actor) {
    const e = await this.store.findById<EntityRow>(C.entities, id);
    if (!e) throw new NotFoundException('Entity not found');
    const updated = await this.store.update<EntityRow>(C.entities, id, { ...input, updatedAt: new Date() });
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'entity.updated', resourceType: 'entity', resourceId: id, details: { before: e, after: input } });
    return updated;
  }
}

@Controller('api/admin')
export class AppsController {
  constructor(private readonly apps: AppsService) {}

  @Get('apps')
  list() {
    return this.apps.listApps();
  }

  @Post('apps')
  create(@Body(new ZodPipe(AppSchema)) body: z.infer<typeof AppSchema>, @CurrentActor() actor: Actor) {
    return this.apps.createApp(body, actor);
  }

  @Patch('apps/:id')
  update(@Param('id') id: string, @Body(new ZodPipe(patchSchema(AppSchema))) body: Partial<z.infer<typeof AppSchema>>, @CurrentActor() actor: Actor) {
    return this.apps.updateApp(id, body, actor);
  }

  @Get('entities')
  entities(@Query('q') q?: string) {
    return this.apps.listEntities(q);
  }

  @Post('entities')
  createEntity(@Body(new ZodPipe(EntitySchema)) body: z.infer<typeof EntitySchema>, @CurrentActor() actor: Actor) {
    return this.apps.createEntity(body, actor);
  }

  @Patch('entities/:id')
  updateEntity(@Param('id') id: string, @Body(new ZodPipe(patchSchema(EntitySchema))) body: Partial<z.infer<typeof EntitySchema>>, @CurrentActor() actor: Actor) {
    return this.apps.updateEntity(id, body, actor);
  }
}
