import { ApiKeyRow, AppRow, ModelRow, RouteRow, Snapshot } from '../catalog/catalog.service';
import { Pricing } from '../providers/presets';
import { ChatMessage, estimateMessagesTokens, textOf, Usage } from './types';

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly type: string = 'invalid_request_error',
    public readonly code: string = 'bad_request',
  ) {
    super(message);
  }
}

export interface CostBreakdown {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
}

/** Computes cost in USD from normalised usage and per-1M-token pricing. */
export function computeCost(usage: Usage, p: Pricing | undefined): CostBreakdown {
  if (!p) return { costUsd: 0, inputCostUsd: 0, outputCostUsd: 0 };
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens);
  const inputCost = (uncached * p.input + usage.cachedTokens * (p.cachedInput ?? p.input) + usage.cacheWriteTokens * (p.cacheWrite ?? p.input)) / 1_000_000;
  const outputCost = (usage.outputTokens * p.output) / 1_000_000;
  const total = inputCost + outputCost + (p.perRequest ?? 0);
  const r = (n: number) => Math.round(n * 1e10) / 1e10;
  return { costUsd: r(total), inputCostUsd: r(inputCost), outputCostUsd: r(outputCost) };
}

export interface ResolvedRoute {
  candidates: ModelRow[];
  route?: RouteRow;
  /** Why "auto" picked a tier (for debugging headers). */
  decision?: string;
}

function weightedOrder(targets: { model: ModelRow; weight: number }[]): ModelRow[] {
  const pool = [...targets];
  const out: ModelRow[] = [];
  while (pool.length) {
    const total = pool.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * (total || 1);
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= pool[idx].weight || (total ? 0 : 1);
      if (r <= 0) break;
    }
    out.push(pool[idx].model);
    pool.splice(idx, 1);
  }
  return out;
}

const price = (m: ModelRow) => (m.pricing?.input ?? 0) + (m.pricing?.output ?? 0);

/** Heuristic complexity classifier for the "auto" (cheap vs strong) strategy. */
export function classifyComplexity(messages: ChatMessage[], hasTools: boolean, thresholdTokens: number, keywords: string[]): { strong: boolean; reason: string } {
  const tokens = estimateMessagesTokens(messages);
  if (tokens > thresholdTokens) return { strong: true, reason: `long_context(${tokens})` };
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = textOf(lastUser?.content ?? '').toLowerCase();
  const kw = keywords.find((k) => k && text.includes(k.toLowerCase()));
  if (kw) return { strong: true, reason: `keyword(${kw})` };
  if (hasTools && messages.filter((m) => m.role === 'tool').length >= 3) return { strong: true, reason: 'multi_step_tools' };
  if (/```|\bdef |\bclass |\bfunction\b|SELECT .* FROM/i.test(text) && text.length > 1500) return { strong: true, reason: 'code' };
  return { strong: false, reason: 'simple' };
}

export function keyAllowsModel(key: ApiKeyRow, m: ModelRow): boolean {
  if (key.access?.mode !== 'restricted') return true;
  return !!(key.access.modelIds?.includes(m.id) || key.access.providerIds?.includes(m.providerId));
}

export function resolveModel(
  snap: Snapshot,
  requested: string | undefined,
  key: ApiKeyRow,
  app: AppRow,
  endpoint: 'chat' | 'embedding',
  ctx: { messages?: ChatMessage[]; hasTools?: boolean; autoThreshold: number; autoKeywords: string[] },
): ResolvedRoute {
  const name = (requested || app.settings?.defaultModel || '').trim().toLowerCase();
  if (!name) throw new GatewayError(400, 'The "model" field is required', 'invalid_request_error', 'model_required');

  const usable = (m: ModelRow | undefined): m is ModelRow => {
    if (!m || m.status !== 'active' || m.type !== endpoint) return false;
    const p = snap.providers.get(m.providerId);
    if (!p || p.status !== 'active') return false;
    const appAllowed = app.settings?.allowedModelIds;
    if (appAllowed?.length && !appAllowed.includes(m.id)) return false;
    return true;
  };

  const route = snap.routesBySlug.get(name);
  if (route) {
    if (route.status !== 'active') throw new GatewayError(404, `Route "${name}" is disabled`, 'invalid_request_error', 'model_not_found');
    const routeAllowed = key.access?.mode !== 'restricted' || key.access.routeIds?.includes(route.id);
    if (!routeAllowed) throw new GatewayError(403, `This key is not allowed to use "${name}"`, 'permission_error', 'model_not_allowed');
    let ordered: ModelRow[];
    let decision: string | undefined;
    switch (route.strategy) {
      case 'loadbalance':
        ordered = weightedOrder(route.targets.map((t) => ({ model: snap.models.get(t.modelId)!, weight: t.weight ?? 1 })).filter((t) => usable(t.model)));
        break;
      case 'cheapest':
        ordered = route.targets.map((t) => snap.models.get(t.modelId)).filter(usable).sort((a, b) => price(a) - price(b));
        break;
      case 'auto': {
        const cfg = route.autoConfig ?? { cheap: [], strong: [] };
        const c = classifyComplexity(ctx.messages ?? [], !!ctx.hasTools, cfg.thresholdTokens ?? ctx.autoThreshold, cfg.strongKeywords?.length ? cfg.strongKeywords : ctx.autoKeywords);
        decision = `${c.strong ? 'strong' : 'cheap'}:${c.reason}`;
        const cheap = cfg.cheap.map((id) => snap.models.get(id)).filter(usable);
        const strong = cfg.strong.map((id) => snap.models.get(id)).filter(usable);
        ordered = c.strong ? [...strong, ...cheap] : [...cheap, ...strong];
        break;
      }
      default:
        ordered = route.targets.map((t) => snap.models.get(t.modelId)).filter(usable);
    }
    if (!ordered.length) throw new GatewayError(503, `No available model for route "${name}"`, 'api_error', 'no_available_model');
    return { candidates: ordered, route, decision };
  }

  let model = snap.modelsBySlug.get(name);
  if (!model) {
    // Convenience: accept the bare upstream id ("gpt-4o") when it is unambiguous.
    const matches = (snap.modelsByProviderModel.get(name) ?? []).filter(usable);
    if (matches.length === 1) model = matches[0];
    else if (matches.length > 1) {
      const allowed = matches.filter((m) => keyAllowsModel(key, m));
      if (allowed.length === 1) model = allowed[0];
      else throw new GatewayError(400, `Model "${name}" is ambiguous; use one of: ${matches.map((m) => m.slug).join(', ')}`, 'invalid_request_error', 'model_ambiguous');
    }
  }
  if (!model || !usable(model)) throw new GatewayError(404, `Model "${name}" does not exist or is not available`, 'invalid_request_error', 'model_not_found');
  if (!keyAllowsModel(key, model)) throw new GatewayError(403, `This key is not allowed to use "${model.slug}"`, 'permission_error', 'model_not_allowed');
  return { candidates: [model] };
}

/** Filters route candidates by key permissions only when the key is restricted and the route is not explicitly allowed. */
export function filterByKey(candidates: ModelRow[], key: ApiKeyRow, route?: RouteRow): ModelRow[] {
  if (route && (key.access?.mode !== 'restricted' || key.access.routeIds?.includes(route.id))) return candidates;
  return candidates.filter((m) => keyAllowsModel(key, m));
}
