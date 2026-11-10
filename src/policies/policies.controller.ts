import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { CurrentActor } from '../auth/decorators';
import { BudgetRow, CatalogService, GuardrailRow, RouteRow } from '../catalog/catalog.service';
import { checkInput, mergePolicies, PII_ENTITIES } from '../guardrails/engine';
import { BudgetsService } from '../gateway/budgets.service';

// ---------------- Routes ----------------
const RouteSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9._:/-]+$/i),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  strategy: z.enum(['fallback', 'loadbalance', 'auto', 'cheapest']),
  targets: z.array(z.object({ modelId: z.string(), weight: z.number().min(0).max(1000).optional() })).max(20).default([]),
  autoConfig: z
    .object({ cheap: z.array(z.string()).max(10), strong: z.array(z.string()).max(10), thresholdTokens: z.number().int().positive().optional(), strongKeywords: z.array(z.string()).max(100).optional() })
    .optional(),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(10).optional() }).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
});

// ---------------- Guardrails ----------------
const PatternSchema = z.object({ pattern: z.string().min(1).max(500), description: z.string().max(200).optional() });
const GuardrailSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  isDefault: z.boolean().default(false),
  config: z.object({
    pii: z.object({ mode: z.enum(['off', 'redact', 'mask_restore', 'block']), entities: z.array(z.enum(PII_ENTITIES as [string, ...string[]])).optional() }).optional(),
    blockedPatterns: z.array(PatternSchema).max(100).optional(),
    blockedKeywords: z.array(z.string().max(200)).max(500).optional(),
    promptInjection: z.enum(['off', 'flag', 'block']).optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    outputBlockedPatterns: z.array(PatternSchema).max(100).optional(),
  }),
});

// ---------------- Budgets ----------------
const BudgetSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.object({ appId: z.string().optional(), entityId: z.string().optional(), keyId: z.string().optional(), providerId: z.string().optional(), modelId: z.string().optional() }),
  period: z.enum(['daily', 'weekly', 'monthly', 'total']),
  amountUsd: z.number().positive().max(100_000_000),
  action: z.enum(['block', 'notify']),
  thresholds: z.array(z.number().min(1).max(100)).max(10).default([50, 80, 100]),
  notifyEmails: z.array(z.string().email()).max(50).default([]),
  status: z.enum(['active', 'disabled']).default('active'),
});

function validatePatterns(cfg: z.infer<typeof GuardrailSchema>['config']) {
  for (const p of [...(cfg.blockedPatterns ?? []), ...(cfg.outputBlockedPatterns ?? [])]) {
    try {
      new RegExp(p.pattern, 'i');
    } catch {
      throw new BadRequestException(`Invalid regular expression: ${p.pattern}`);
    }
  }
}

@Injectable()
export class PoliciesService {
  constructor(private readonly store: Store, private readonly audit: AuditService, private readonly catalog: CatalogService, private readonly budgets: BudgetsService) {}

  private async upsert<T extends { id: string }>(collection: string, type: string, id: string | undefined, data: Record<string, unknown>, actor: Actor): Promise<T> {
    let row: T | null;
    if (id) {
      const before = await this.store.findById(collection, id);
      if (!before) throw new NotFoundException(`${type} not found`);
      row = await this.store.update<T>(collection, id, { ...data, updatedAt: new Date() });
      await this.audit.log(actor, { action: `${type}.updated`, resourceType: type, resourceId: id, details: { before, after: data } });
    } else {
      row = await this.store.insert(collection, { id: CryptoService.id(), ...data, createdAt: new Date(), updatedAt: new Date() } as any);
      await this.audit.log(actor, { action: `${type}.created`, resourceType: type, resourceId: row!.id, details: data });
    }
    this.catalog.invalidate();
    return row!;
  }

  routes() {
    return this.store.find<RouteRow>(C.routes, {}, { sort: { slug: 1 } });
  }

  async saveRoute(id: string | undefined, input: z.infer<typeof RouteSchema>, actor: Actor) {
    const slug = input.slug.toLowerCase();
    const clash = await this.store.findOne<RouteRow>(C.routes, { slug });
    if (clash && clash.id !== id) throw new BadRequestException(`Route "${slug}" already exists`);
    if (await this.store.findOne(C.models, { slug })) throw new BadRequestException(`"${slug}" is already a model slug`);
    if (input.strategy === 'auto' && (!input.autoConfig?.cheap.length || !input.autoConfig?.strong.length)) {
      throw new BadRequestException('Auto routing needs at least one cheap and one strong model');
    }
    if (input.strategy !== 'auto' && !input.targets.length) throw new BadRequestException('Add at least one target model');
    return this.upsert<RouteRow>(C.routes, 'route', id, { ...input, slug }, actor);
  }

  guardrails() {
    return this.store.find<GuardrailRow>(C.guardrails, {}, { sort: { name: 1 } });
  }

  saveGuardrail(id: string | undefined, input: z.infer<typeof GuardrailSchema>, actor: Actor) {
    validatePatterns(input.config);
    return this.upsert<GuardrailRow>(C.guardrails, 'guardrail', id, input, actor);
  }

  async testGuardrail(id: string, text: string) {
    const g = await this.store.findById<GuardrailRow>(C.guardrails, id);
    if (!g) throw new NotFoundException();
    const res = checkInput([{ role: 'user', content: text }], mergePolicies([{ id: g.id, config: g.config }]));
    return { blocked: res.blocked, flags: res.flags, redactions: res.redactions, output: res.messages[0].content, vault: res.vault ? Object.fromEntries(res.vault) : undefined };
  }

  async listBudgets() {
    const rows = await this.store.find<BudgetRow>(C.budgets, {}, { sort: { name: 1 } });
    return Promise.all(rows.map(async (b) => ({ ...b, ...(await this.budgets.status(b)) })));
  }

  saveBudget(id: string | undefined, input: z.infer<typeof BudgetSchema>, actor: Actor) {
    const scope = Object.fromEntries(Object.entries(input.scope).filter(([, v]) => v));
    return this.upsert<BudgetRow>(C.budgets, 'budget', id, { ...input, scope, thresholds: [...new Set(input.thresholds)].sort((a, b) => a - b) }, actor);
  }

  async resetBudget(id: string, actor: Actor) {
    const b = await this.store.findById<BudgetRow>(C.budgets, id);
    if (!b) throw new NotFoundException();
    await this.budgets.reset(b);
    await this.audit.log(actor, { action: 'budget.reset', resourceType: 'budget', resourceId: id });
    return { ok: true };
  }
}

@Controller('api/admin')
export class PoliciesController {
  constructor(private readonly svc: PoliciesService) {}

  @Get('routes') routes() { return this.svc.routes(); }
  @Post('routes') createRoute(@Body(new ZodPipe(RouteSchema)) b: z.infer<typeof RouteSchema>, @CurrentActor() a: Actor) { return this.svc.saveRoute(undefined, b, a); }
  @Patch('routes/:id') updateRoute(@Param('id') id: string, @Body(new ZodPipe(RouteSchema)) b: z.infer<typeof RouteSchema>, @CurrentActor() a: Actor) { return this.svc.saveRoute(id, b, a); }

  @Get('guardrails') guardrails() { return this.svc.guardrails(); }
  @Get('guardrails-meta') meta() { return { piiEntities: PII_ENTITIES }; }
  @Post('guardrails') createGuardrail(@Body(new ZodPipe(GuardrailSchema)) b: z.infer<typeof GuardrailSchema>, @CurrentActor() a: Actor) { return this.svc.saveGuardrail(undefined, b, a); }
  @Patch('guardrails/:id') updateGuardrail(@Param('id') id: string, @Body(new ZodPipe(GuardrailSchema)) b: z.infer<typeof GuardrailSchema>, @CurrentActor() a: Actor) { return this.svc.saveGuardrail(id, b, a); }
  @Post('guardrails/:id/test') testGuardrail(@Param('id') id: string, @Body() b: { text?: string }) { return this.svc.testGuardrail(id, String(b?.text ?? '').slice(0, 20000)); }

  @Get('budgets') budgets() { return this.svc.listBudgets(); }
  @Post('budgets') createBudget(@Body(new ZodPipe(BudgetSchema)) b: z.infer<typeof BudgetSchema>, @CurrentActor() a: Actor) { return this.svc.saveBudget(undefined, b, a); }
  @Patch('budgets/:id') updateBudget(@Param('id') id: string, @Body(new ZodPipe(BudgetSchema)) b: z.infer<typeof BudgetSchema>, @CurrentActor() a: Actor) { return this.svc.saveBudget(id, b, a); }
  @Post('budgets/:id/reset') resetBudget(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.resetBudget(id, a); }
}

