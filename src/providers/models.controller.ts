import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { CurrentActor } from '../auth/decorators';
import { CatalogService, ModelRow, ProviderRow } from '../catalog/catalog.service';

const PricingSchema = z.object({
  input: z.number().min(0).max(10_000),
  output: z.number().min(0).max(10_000),
  cachedInput: z.number().min(0).max(10_000).optional(),
  cacheWrite: z.number().min(0).max(10_000).optional(),
  perRequest: z.number().min(0).max(100).optional(),
});
const CapsSchema = z.object({
  vision: z.boolean().optional(), tools: z.boolean().optional(), streaming: z.boolean().optional(),
  json: z.boolean().optional(), sampling: z.boolean().optional(), reasoning: z.boolean().optional(),
});
const ModelSchema = z.object({
  providerId: z.string().min(1),
  providerModelId: z.string().min(1).max(200),
  slug: z.string().max(200).regex(/^[a-z0-9._:/-]+$/i, 'Letters, digits, . _ : / - only').optional(),
  displayName: z.string().min(1).max(200),
  type: z.enum(['chat', 'embedding']).default('chat'),
  tier: z.enum(['cheap', 'standard', 'strong']).default('standard'),
  status: z.enum(['active', 'disabled']).default('active'),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  pricing: PricingSchema,
  capabilities: CapsSchema.default({ tools: true, streaming: true, sampling: true }),
  notes: z.string().max(2000).optional(),
});
const UpdateSchema = ModelSchema.omit({ providerId: true }).partial();

@Injectable()
export class ModelsService {
  constructor(private readonly store: Store, private readonly audit: AuditService, private readonly catalog: CatalogService) {}

  async list() {
    const [models, providers] = await Promise.all([this.store.find<ModelRow>(C.models, {}, { sort: { slug: 1 } }), this.store.find<ProviderRow>(C.providers)]);
    const pm = new Map(providers.map((p) => [p.id, p]));
    return models.map((m) => ({ ...m, providerName: pm.get(m.providerId)?.name, providerSlug: pm.get(m.providerId)?.slug }));
  }

  async create(input: z.infer<typeof ModelSchema>, actor: Actor) {
    const provider = await this.store.findById<ProviderRow>(C.providers, input.providerId);
    if (!provider) throw new BadRequestException('Provider not found');
    const slug = (input.slug || `${provider.slug}/${input.providerModelId}`).toLowerCase();
    if (await this.store.findOne(C.models, { slug })) throw new BadRequestException(`Model slug "${slug}" already exists`);
    if (await this.store.findOne(C.routes, { slug })) throw new BadRequestException(`"${slug}" is already used by a route`);
    const row: ModelRow = { id: CryptoService.id(), ...input, slug, createdAt: new Date(), updatedAt: new Date() };
    await this.store.insert(C.models, row);
    await this.store.insert(C.pricingHistory, { id: CryptoService.id(), modelId: row.id, pricing: row.pricing, changedBy: actor.name, createdAt: new Date() });
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'model.created', resourceType: 'model', resourceId: row.id, details: { slug, pricing: row.pricing } });
    return row;
  }

  async update(id: string, input: z.infer<typeof UpdateSchema>, actor: Actor) {
    const m = await this.store.findById<ModelRow>(C.models, id);
    if (!m) throw new NotFoundException('Model not found');
    if (input.slug && input.slug.toLowerCase() !== m.slug) {
      input.slug = input.slug.toLowerCase();
      if (await this.store.findOne(C.models, { slug: input.slug })) throw new BadRequestException('Slug already exists');
    }
    const updated = await this.store.update<ModelRow>(C.models, id, { ...input, updatedAt: new Date() });
    if (input.pricing && JSON.stringify(input.pricing) !== JSON.stringify(m.pricing)) {
      await this.store.insert(C.pricingHistory, { id: CryptoService.id(), modelId: id, pricing: input.pricing, previous: m.pricing, changedBy: actor.name, createdAt: new Date() });
    }
    this.catalog.invalidate();
    await this.audit.log(actor, { action: input.pricing ? 'model.pricing_updated' : 'model.updated', resourceType: 'model', resourceId: id, details: { before: m, after: input } });
    return updated;
  }

  pricingHistory(id: string) {
    return this.store.find(C.pricingHistory, { modelId: id }, { sort: { createdAt: -1 }, limit: 100 });
  }
}

@Controller('api/admin/models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  list() {
    return this.models.list();
  }

  @Post()
  create(@Body(new ZodPipe(ModelSchema)) body: z.infer<typeof ModelSchema>, @CurrentActor() actor: Actor) {
    return this.models.create(body, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>, @CurrentActor() actor: Actor) {
    return this.models.update(id, body, actor);
  }

  @Get(':id/pricing-history')
  history(@Param('id') id: string) {
    return this.models.pricingHistory(id);
  }
}
