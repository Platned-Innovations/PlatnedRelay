import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { CurrentActor } from '../auth/decorators';
import { ChatMessage } from '../gateway/types';

export interface PromptTemplate {
  messages: { role: 'system' | 'user' | 'assistant' | 'developer'; content: string }[];
  model?: string;
  params?: { temperature?: number; max_tokens?: number; top_p?: number };
}
interface PromptRow { id: string; slug: string; name: string; description?: string; appId?: string; labels: Record<string, number>; latestVersion: number; createdAt: Date; updatedAt: Date }
interface VersionRow { id: string; promptId: string; version: number; template: PromptTemplate; variables: string[]; changelog?: string; createdBy?: string; createdAt: Date }

const TemplateSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'developer']), content: z.string().max(200_000) })).min(1).max(100),
  model: z.string().max(200).optional(),
  params: z.object({ temperature: z.number().min(0).max(2).optional(), max_tokens: z.number().int().positive().optional(), top_p: z.number().min(0).max(1).optional() }).optional(),
});
const CreateSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  appId: z.string().optional(),
  template: TemplateSchema,
  changelog: z.string().max(2000).optional(),
});
const VersionSchema = z.object({ template: TemplateSchema, changelog: z.string().max(2000).optional() });
const LabelSchema = z.object({ label: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/), version: z.number().int().positive().nullable() });

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function templateVariables(t: PromptTemplate): string[] {
  const vars = new Set<string>();
  for (const m of t.messages) for (const match of m.content.matchAll(VAR_RE)) vars.add(match[1]);
  return [...vars];
}

export function renderPrompt(t: PromptTemplate, variables: Record<string, unknown> = {}): ChatMessage[] {
  const missing = templateVariables(t).filter((v) => variables[v] === undefined);
  if (missing.length) throw new BadRequestException(`Missing prompt variables: ${missing.join(', ')}`);
  return t.messages.map((m) => ({
    role: m.role,
    content: m.content.replace(VAR_RE, (_, k) => {
      const v = variables[k];
      return typeof v === 'string' ? v : JSON.stringify(v);
    }),
  }));
}

@Injectable()
export class PromptsService {
  private cache = new Map<string, { at: number; v: { prompt: PromptRow; version: VersionRow } }>();

  constructor(private readonly store: Store, private readonly audit: AuditService) {}

  async list() {
    return this.store.find<PromptRow>(C.prompts, {}, { sort: { slug: 1 } });
  }

  async detail(id: string) {
    const prompt = await this.store.findById<PromptRow>(C.prompts, id);
    if (!prompt) throw new NotFoundException('Prompt not found');
    const versions = await this.store.find<VersionRow>(C.promptVersions, { promptId: id }, { sort: { version: -1 } });
    return { ...prompt, versions };
  }

  async create(input: z.infer<typeof CreateSchema>, actor: Actor) {
    if (await this.store.findOne(C.prompts, { slug: input.slug })) throw new BadRequestException('Slug already exists');
    const prompt: PromptRow = {
      id: CryptoService.id(), slug: input.slug, name: input.name, description: input.description, appId: input.appId,
      labels: { production: 1 }, latestVersion: 1, createdAt: new Date(), updatedAt: new Date(),
    };
    await this.store.insert(C.prompts, prompt);
    await this.store.insert<VersionRow>(C.promptVersions, {
      id: CryptoService.id(), promptId: prompt.id, version: 1, template: input.template, variables: templateVariables(input.template),
      changelog: input.changelog ?? 'Initial version', createdBy: actor.name, createdAt: new Date(),
    });
    await this.audit.log(actor, { action: 'prompt.created', resourceType: 'prompt', resourceId: prompt.id, details: { slug: prompt.slug } });
    return prompt;
  }

  async update(id: string, input: { name?: string; description?: string }, actor: Actor) {
    const p = await this.store.update<PromptRow>(C.prompts, id, { ...input, updatedAt: new Date() });
    if (!p) throw new NotFoundException();
    this.cache.clear();
    await this.audit.log(actor, { action: 'prompt.updated', resourceType: 'prompt', resourceId: id, details: input });
    return p;
  }

  async addVersion(id: string, input: z.infer<typeof VersionSchema>, actor: Actor) {
    const prompt = await this.store.findById<PromptRow>(C.prompts, id);
    if (!prompt) throw new NotFoundException();
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.store.findOne<VersionRow>(C.promptVersions, { promptId: id }, { sort: { version: -1 } });
      const version = (latest?.version ?? 0) + 1;
      try {
        const row = await this.store.insert<VersionRow>(C.promptVersions, {
          id: CryptoService.id(), promptId: id, version, template: input.template, variables: templateVariables(input.template),
          changelog: input.changelog, createdBy: actor.name, createdAt: new Date(),
        });
        await this.store.update(C.prompts, id, { latestVersion: version, updatedAt: new Date() });
        await this.audit.log(actor, { action: 'prompt.version_created', resourceType: 'prompt', resourceId: id, details: { version } });
        return row;
      } catch {
        /* concurrent version insert - retry */
      }
    }
    throw new BadRequestException('Could not create version, retry');
  }

  async setLabel(id: string, input: z.infer<typeof LabelSchema>, actor: Actor) {
    const prompt = await this.store.findById<PromptRow>(C.prompts, id);
    if (!prompt) throw new NotFoundException();
    const labels = { ...(prompt.labels ?? {}) };
    if (input.version === null) delete labels[input.label];
    else {
      if (!(await this.store.findOne(C.promptVersions, { promptId: id, version: input.version }))) throw new BadRequestException('Version not found');
      labels[input.label] = input.version;
    }
    await this.store.update(C.prompts, id, { labels, updatedAt: new Date() });
    this.cache.clear();
    await this.audit.log(actor, { action: 'prompt.label_set', resourceType: 'prompt', resourceId: id, details: { label: input.label, version: input.version, previous: prompt.labels?.[input.label] } });
    return { labels };
  }

  /** Resolves a prompt reference for the gateway: explicit version > label > "production" label > latest. */
  async resolve(ref: { id?: string; slug?: string; version?: number; label?: string }) {
    const cacheKey = JSON.stringify(ref);
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < 15_000) return hit.v;
    const prompt = ref.id ? await this.store.findById<PromptRow>(C.prompts, ref.id) : ref.slug ? await this.store.findOne<PromptRow>(C.prompts, { slug: ref.slug }) : null;
    if (!prompt) throw new BadRequestException('Prompt not found');
    const version = ref.version ?? (ref.label ? prompt.labels?.[ref.label] : undefined) ?? prompt.labels?.production ?? prompt.latestVersion;
    if (ref.label && !prompt.labels?.[ref.label] && !ref.version) throw new BadRequestException(`Prompt label "${ref.label}" not found`);
    const row = await this.store.findOne<VersionRow>(C.promptVersions, { promptId: prompt.id, version });
    if (!row) throw new BadRequestException('Prompt version not found');
    const v = { prompt, version: row };
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(cacheKey, { at: Date.now(), v });
    return v;
  }
}

@Controller('api/admin/prompts')
export class PromptsController {
  constructor(private readonly prompts: PromptsService) {}

  @Get() list() { return this.prompts.list(); }
  @Get(':id') detail(@Param('id') id: string) { return this.prompts.detail(id); }
  @Post() create(@Body(new ZodPipe(CreateSchema)) b: z.infer<typeof CreateSchema>, @CurrentActor() a: Actor) { return this.prompts.create(b, a); }
  @Patch(':id') update(@Param('id') id: string, @Body(new ZodPipe(z.object({ name: z.string().max(200).optional(), description: z.string().max(2000).optional() }))) b: { name?: string; description?: string }, @CurrentActor() a: Actor) { return this.prompts.update(id, b, a); }
  @Post(':id/versions') addVersion(@Param('id') id: string, @Body(new ZodPipe(VersionSchema)) b: z.infer<typeof VersionSchema>, @CurrentActor() a: Actor) { return this.prompts.addVersion(id, b, a); }
  @Post(':id/labels') setLabel(@Param('id') id: string, @Body(new ZodPipe(LabelSchema)) b: z.infer<typeof LabelSchema>, @CurrentActor() a: Actor) { return this.prompts.setLabel(id, b, a); }
  @Post(':id/render') render(@Param('id') id: string, @Body() b: { version?: number; label?: string; variables?: Record<string, unknown> }) {
    return this.prompts.resolve({ id, version: b?.version, label: b?.label }).then((r) => ({ version: r.version.version, messages: renderPrompt(r.version.template, b?.variables ?? {}) }));
  }
}
