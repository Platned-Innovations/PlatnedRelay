import { Injectable, Logger } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { ModelCapabilities, ModelRuntime, ProviderRuntime, ProviderType } from '../providers/adapters';
import { Pricing } from '../providers/presets';

export interface ProviderRow {
  id: string; name: string; slug: string; type: ProviderType; presetId?: string; baseUrl: string;
  config?: Record<string, any>; secretsEnc?: string; status: 'active' | 'disabled'; timeoutMs?: number; maxRetries?: number;
  lastTestAt?: Date; lastTestOk?: boolean; lastTestMessage?: string; createdAt: Date; updatedAt: Date;
}
export interface ModelRow {
  id: string; providerId: string; slug: string; providerModelId: string; displayName: string; type: 'chat' | 'embedding';
  status: 'active' | 'disabled'; contextWindow?: number; maxOutputTokens?: number; pricing: Pricing; capabilities?: ModelCapabilities;
  tier?: 'cheap' | 'standard' | 'strong'; notes?: string; createdAt: Date; updatedAt: Date;
}
export interface RouteTarget { modelId: string; weight?: number }
export interface RouteRow {
  id: string; slug: string; name: string; description?: string; strategy: 'fallback' | 'loadbalance' | 'auto' | 'cheapest';
  targets: RouteTarget[]; autoConfig?: { cheap: string[]; strong: string[]; thresholdTokens?: number; strongKeywords?: string[] };
  retry?: { maxAttempts?: number }; status: 'active' | 'disabled'; createdAt: Date; updatedAt: Date;
}
export interface AppSettings {
  cacheEnabled?: boolean; cacheTtlSeconds?: number; logBodies?: boolean; guardrailPolicyIds?: string[];
  allowedModelIds?: string[]; defaultModel?: string; rpm?: number;
}
export interface AppRow {
  id: string; name: string; slug: string; description?: string; owner?: string; ownerEmail?: string;
  status: 'active' | 'disabled'; settings?: AppSettings; tags?: string[]; createdAt: Date; updatedAt: Date;
}
export interface EntityRow { id: string; name: string; type: string; email?: string; description?: string; status: 'active' | 'disabled'; createdAt: Date; updatedAt: Date }
export interface KeyAccess { mode: 'all' | 'restricted'; providerIds?: string[]; modelIds?: string[]; routeIds?: string[] }
export interface KeyLimits { rpm?: number; tpm?: number; maxTokensPerRequest?: number; maxConcurrent?: number }
export interface ApiKeyRow {
  id: string; name: string; appId: string; entityId: string; keyHash: string; prefix: string; last4: string;
  status: 'active' | 'inactive' | 'revoked'; expiresAt?: Date; access: KeyAccess; limits?: KeyLimits; ipAllowlist?: string[];
  metadata?: Record<string, unknown>; createdBy?: string; lastUsedAt?: Date; revokedAt?: Date; revokedBy?: string; revokeReason?: string;
  rotatedAt?: Date; rotationCount?: number; createdAt: Date; updatedAt: Date;
}
export interface GuardrailConfig {
  pii?: { mode: 'off' | 'redact' | 'mask_restore' | 'block'; entities?: string[] };
  blockedPatterns?: { pattern: string; description?: string }[];
  blockedKeywords?: string[];
  promptInjection?: 'off' | 'flag' | 'block';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  outputBlockedPatterns?: { pattern: string; description?: string }[];
}
export interface GuardrailRow { id: string; name: string; description?: string; status: 'active' | 'disabled'; isDefault?: boolean; config: GuardrailConfig; createdAt: Date; updatedAt: Date }
export interface BudgetScope { appId?: string; entityId?: string; keyId?: string; providerId?: string; modelId?: string }
export interface BudgetRow {
  id: string; name: string; scope: BudgetScope; period: 'daily' | 'weekly' | 'monthly' | 'total'; amountUsd: number;
  action: 'block' | 'notify'; thresholds: number[]; notifyEmails?: string[]; status: 'active' | 'disabled'; createdAt: Date; updatedAt: Date;
}

export interface Snapshot {
  loadedAt: number;
  providers: Map<string, ProviderRuntime & { status: string; timeoutMs?: number; maxRetries?: number; name: string }>;
  models: Map<string, ModelRow>;
  modelsBySlug: Map<string, ModelRow>;
  modelsByProviderModel: Map<string, ModelRow[]>;
  routesBySlug: Map<string, RouteRow>;
  apps: Map<string, AppRow>;
  entities: Map<string, EntityRow>;
  guardrails: GuardrailRow[];
  budgets: BudgetRow[];
}

const SNAPSHOT_TTL_MS = 15_000;
const KEY_TTL_MS = 15_000;

/**
 * In-memory read model for the gateway hot path. Configuration rarely changes,
 * so it is loaded once and refreshed every 15s (or immediately after admin
 * changes on this instance). This keeps per-request DB access to ~zero and
 * lets each instance serve thousands of concurrent requests.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger('Catalog');
  private snap?: Snapshot;
  private loading?: Promise<Snapshot>;
  private keys = new Map<string, { at: number; key: ApiKeyRow | null }>();

  constructor(private readonly store: Store, private readonly crypto: CryptoService) {}

  async snapshot(): Promise<Snapshot> {
    if (this.snap && Date.now() - this.snap.loadedAt < SNAPSHOT_TTL_MS) return this.snap;
    if (this.snap) {
      // Serve stale while refreshing in the background (never block requests on reload).
      void this.reload().catch((e) => this.logger.error(`Catalog refresh failed: ${e.message}`));
      return this.snap;
    }
    return this.reload();
  }

  invalidate() {
    if (this.snap) this.snap.loadedAt = 0;
  }

  invalidateKeys() {
    this.keys.clear();
  }

  private reload(): Promise<Snapshot> {
    if (!this.loading) {
      this.loading = this.load().finally(() => (this.loading = undefined));
    }
    return this.loading;
  }

  private async load(): Promise<Snapshot> {
    const [providers, models, routes, apps, entities, guardrails, budgets] = await Promise.all([
      this.store.find<ProviderRow>(C.providers),
      this.store.find<ModelRow>(C.models),
      this.store.find<RouteRow>(C.routes),
      this.store.find<AppRow>(C.apps),
      this.store.find<EntityRow>(C.entities),
      this.store.find<GuardrailRow>(C.guardrails, { status: 'active' }),
      this.store.find<BudgetRow>(C.budgets, { status: 'active' }),
    ]);
    const snap: Snapshot = {
      loadedAt: Date.now(),
      providers: new Map(),
      models: new Map(models.map((m) => [m.id, m])),
      modelsBySlug: new Map(models.map((m) => [m.slug.toLowerCase(), m])),
      modelsByProviderModel: new Map(),
      routesBySlug: new Map(routes.map((r) => [r.slug.toLowerCase(), r])),
      apps: new Map(apps.map((a) => [a.id, a])),
      entities: new Map(entities.map((e) => [e.id, e])),
      guardrails,
      budgets,
    };
    for (const m of models) {
      const k = m.providerModelId.toLowerCase();
      snap.modelsByProviderModel.set(k, [...(snap.modelsByProviderModel.get(k) ?? []), m]);
    }
    for (const p of providers) {
      let secrets: Record<string, string> = {};
      if (p.secretsEnc) {
        try {
          secrets = this.crypto.decryptJson(p.secretsEnc, `provider:${p.id}:secrets`);
        } catch (e: any) {
          this.logger.error(`Cannot decrypt secrets of provider ${p.slug}: ${e.message}`);
        }
      }
      snap.providers.set(p.id, {
        id: p.id, slug: p.slug, name: p.name, type: p.type, baseUrl: p.baseUrl, config: p.config ?? {}, secrets,
        status: p.status, timeoutMs: p.timeoutMs, maxRetries: p.maxRetries,
      });
    }
    this.snap = snap;
    return snap;
  }

  /** Resolves a relay API key by its HMAC digest (cached briefly; revocations propagate within 15s cluster-wide, instantly locally). */
  async keyByHash(hash: string, previousHash?: string): Promise<ApiKeyRow | null> {
    const hit = this.keys.get(hash);
    if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key;
    let key = await this.store.findOne<ApiKeyRow>(C.apiKeys, { keyHash: hash });
    if (!key && previousHash) key = await this.store.findOne<ApiKeyRow>(C.apiKeys, { keyHash: previousHash });
    if (this.keys.size > 50_000) this.keys.clear();
    this.keys.set(hash, { at: Date.now(), key });
    return key;
  }

  modelRuntime(m: ModelRow): ModelRuntime {
    return { id: m.id, slug: m.slug, providerModelId: m.providerModelId, maxOutputTokens: m.maxOutputTokens, capabilities: m.capabilities ?? {} };
  }
}
