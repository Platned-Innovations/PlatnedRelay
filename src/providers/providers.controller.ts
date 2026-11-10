import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, MASK, slugify, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { CurrentActor } from '../auth/decorators';
import { CatalogService, ModelRow, ProviderRow } from '../catalog/catalog.service';
import { adapterFor, PROVIDER_TYPES, ProviderRuntime, ProviderType } from './adapters';
import { PRESETS, presetById, PresetModel } from './presets';

const ProviderSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().max(60).optional(),
  presetId: z.string().max(60).optional(),
  type: z.enum(PROVIDER_TYPES as [ProviderType, ...ProviderType[]]),
  baseUrl: z.string().url().max(500),
  apiKey: z.string().max(4000).optional(),
  /** JSON object of secret headers, e.g. {"X-Tenant-Token":"..."} */
  secretHeaders: z.string().max(8000).optional(),
  config: z.record(z.string(), z.any()).default({}),
  timeoutMs: z.number().int().min(1000).max(900_000).nullable().optional(),
  maxRetries: z.number().int().min(0).max(5).nullable().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  importPresetModels: z.boolean().default(true),
});
const UpdateSchema = ProviderSchema.omit({ importPresetModels: true, presetId: true }).partial();

@Injectable()
export class ProvidersService {
  constructor(private readonly store: Store, private readonly crypto: CryptoService, private readonly audit: AuditService, private readonly catalog: CatalogService) {}

  private ctx(id: string) {
    return `provider:${id}:secrets`;
  }

  private secrets(p: ProviderRow): Record<string, string> {
    return p.secretsEnc ? this.crypto.decryptJson(p.secretsEnc, this.ctx(p.id)) : {};
  }

  private view(p: ProviderRow) {
    const s = this.secrets(p);
    const { secretsEnc, ...rest } = p;
    return {
      ...rest,
      hasApiKey: !!s.apiKey,
      apiKeyHint: s.apiKey ? `${MASK}${s.apiKey.slice(-4)}` : undefined,
      hasSecretHeaders: !!s.headers,
    };
  }

  async list() {
    const [rows, counts] = await Promise.all([
      this.store.find<ProviderRow>(C.providers, {}, { sort: { name: 1 } }),
      this.store.aggregate(C.models, { groupBy: ['providerId'], metrics: { n: { op: 'count' } } }),
    ]);
    const byProvider = new Map(counts.map((c) => [c.providerId, c.n]));
    return rows.map((r) => ({ ...this.view(r), modelCount: byProvider.get(r.id) ?? 0 }));
  }

  async get(id: string) {
    const p = await this.store.findById<ProviderRow>(C.providers, id);
    if (!p) throw new NotFoundException('Provider not found');
    return p;
  }

  async create(input: z.infer<typeof ProviderSchema>, actor: Actor) {
    const slug = slugify(input.slug || input.name).replace(/\//g, '-');
    if (!slug) throw new BadRequestException('Invalid slug');
    if (await this.store.findOne(C.providers, { slug })) throw new BadRequestException(`Provider slug "${slug}" already exists`);
    const id = CryptoService.id();
    const secrets: Record<string, string> = {};
    if (input.apiKey) secrets.apiKey = input.apiKey.trim();
    if (input.secretHeaders) secrets.headers = validateHeaders(input.secretHeaders);
    const row: ProviderRow = {
      id, name: input.name, slug, type: input.type, presetId: input.presetId, baseUrl: input.baseUrl.replace(/\/$/, ''),
      config: { ...(presetById(input.presetId)?.config ?? {}), ...input.config }, status: input.status,
      secretsEnc: Object.keys(secrets).length ? this.crypto.encryptJson(secrets, this.ctx(id)) : undefined,
      timeoutMs: input.timeoutMs ?? undefined, maxRetries: input.maxRetries ?? undefined, createdAt: new Date(), updatedAt: new Date(),
    };
    await this.store.insert(C.providers, { ...row, createdBy: actor.id } as any);
    let imported = 0;
    if (input.importPresetModels && input.presetId) imported = await this.importPresetModels(row, actor, false);
    this.catalog.invalidate();
    await this.audit.log(actor, { action: 'provider.created', resourceType: 'provider', resourceId: id, details: { name: row.name, slug, type: row.type, baseUrl: row.baseUrl, importedModels: imported } });
    return this.view(row);
  }

  async update(id: string, input: z.infer<typeof UpdateSchema>, actor: Actor) {
    const p = await this.get(id);
    const secrets = this.secrets(p);
    const changedSecrets: string[] = [];
    if (input.apiKey !== undefined && !input.apiKey.startsWith(MASK)) {
      if (input.apiKey) secrets.apiKey = input.apiKey.trim();
      else delete secrets.apiKey;
      changedSecrets.push('apiKey');
    }
    if (input.secretHeaders !== undefined && input.secretHeaders !== MASK) {
      if (input.secretHeaders) secrets.headers = validateHeaders(input.secretHeaders);
      else delete secrets.headers;
      changedSecrets.push('headers');
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['name', 'type', 'config', 'timeoutMs', 'maxRetries', 'status'] as const) if (input[k] !== undefined) patch[k] = input[k];
    if (input.baseUrl) patch.baseUrl = input.baseUrl.replace(/\/$/, '');
    if (input.slug && input.slug !== p.slug) {
      const slug = slugify(input.slug).replace(/\//g, '-');
      if (await this.store.findOne(C.providers, { slug })) throw new BadRequestException('Slug already exists');
      patch.slug = slug;
    }
    if (changedSecrets.length) patch.secretsEnc = Object.keys(secrets).length ? this.crypto.encryptJson(secrets, this.ctx(id)) : null;
    const updated = await this.store.update<ProviderRow>(C.providers, id, patch);
    this.catalog.invalidate();
    const { secretsEnc, ...safePatch } = patch;
    await this.audit.log(actor, { action: 'provider.updated', resourceType: 'provider', resourceId: id, details: { changes: safePatch, secretsChanged: changedSecrets } });
    return this.view(updated!);
  }

  runtime(p: ProviderRow): ProviderRuntime {
    return { id: p.id, slug: p.slug, type: p.type, baseUrl: p.baseUrl, config: p.config ?? {}, secrets: this.secrets(p) };
  }

  async test(id: string, actor: Actor) {
    const p = await this.get(id);
    const rt = this.runtime(p);
    const adapter = adapterFor(p.type);
    const started = Date.now();
    let ok = false;
    let message = '';
    try {
      if (adapter.listModels) {
        const models = await adapter.listModels(rt, 20_000);
        ok = true;
        message = `Connected. ${models.length} model(s) available.`;
      } else {
        const model = await this.store.findOne<ModelRow>(C.models, { providerId: id, type: 'chat' });
        if (!model) throw new Error('Add at least one model to test this provider');
        await adapter.chat(
          { provider: rt, model: { id: model.id, slug: model.slug, providerModelId: model.providerModelId, capabilities: model.capabilities ?? {} }, timeoutMs: 30_000 },
          { model: model.slug, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 },
        );
        ok = true;
        message = 'Connected. Test completion succeeded.';
      }
    } catch (e: any) {
      message = e.message?.slice(0, 500) ?? 'Unknown error';
    }
    await this.store.update(C.providers, id, { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message });
    await this.audit.log(actor, { action: 'provider.tested', resourceType: 'provider', resourceId: id, outcome: ok ? 'success' : 'failure', details: { message } });
    return { ok, message, latencyMs: Date.now() - started };
  }

  async discover(id: string) {
    const p = await this.get(id);
    const adapter = adapterFor(p.type);
    if (!adapter.listModels) return { available: [], existing: [] };
    const available = await adapter.listModels(this.runtime(p), 20_000);
    const existing = (await this.store.find<ModelRow>(C.models, { providerId: id })).map((m) => m.providerModelId);
    return { available: available.sort(), existing };
  }

  async importPresetModels(p: ProviderRow, actor: Actor, audit = true): Promise<number> {
    const preset = presetById(p.presetId);
    if (!preset) return 0;
    let n = 0;
    for (const m of preset.models) if (await this.insertPresetModel(p, m)) n++;
    this.catalog.invalidate();
    if (audit) await this.audit.log(actor, { action: 'provider.models_imported', resourceType: 'provider', resourceId: p.id, details: { count: n } });
    return n;
  }

  private async insertPresetModel(p: ProviderRow, m: PresetModel): Promise<boolean> {
    const slug = `${p.slug}/${m.id}`.toLowerCase();
    if (await this.store.findOne(C.models, { slug })) return false;
    await this.store.insert<ModelRow>(C.models, {
      id: CryptoService.id(), providerId: p.id, slug, providerModelId: m.id, displayName: m.name, type: m.type ?? 'chat', status: 'active',
      contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens, pricing: m.pricing, capabilities: m.capabilities ?? {}, tier: m.tier,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return true;
  }
}

function validateHeaders(json: string): string {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string')) throw new Error();
    return JSON.stringify(v);
  } catch {
    throw new BadRequestException('secretHeaders must be a JSON object of string values');
  }
}

@Controller('api/admin/providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('presets')
  presets() {
    return PRESETS;
  }

  @Get()
  list() {
    return this.providers.list();
  }

  @Post()
  create(@Body(new ZodPipe(ProviderSchema)) body: z.infer<typeof ProviderSchema>, @CurrentActor() actor: Actor) {
    return this.providers.create(body, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>, @CurrentActor() actor: Actor) {
    return this.providers.update(id, body, actor);
  }

  @Post(':id/test')
  test(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.providers.test(id, actor);
  }

  @Get(':id/discover')
  discover(@Param('id') id: string) {
    return this.providers.discover(id);
  }

  @Post(':id/import-preset-models')
  async importPreset(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const p = await this.providers.get(id);
    return { imported: await this.providers.importPresetModels(p, actor) };
  }
}
