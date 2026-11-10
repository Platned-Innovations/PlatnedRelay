import { CollectionDef } from './store';

/**
 * Single source of truth for the data model. Both adapters create/upgrade
 * tables/collections and indexes from these definitions at startup
 * (additive, non-destructive schema evolution).
 */
export const C = {
  users: 'users',
  sessions: 'sessions',
  settings: 'settings',
  providers: 'providers',
  models: 'models',
  pricingHistory: 'pricing_history',
  routes: 'routes',
  apps: 'apps',
  entities: 'entities',
  apiKeys: 'api_keys',
  keyEvents: 'key_events',
  prompts: 'prompts',
  promptVersions: 'prompt_versions',
  guardrails: 'guardrail_policies',
  budgets: 'budgets',
  budgetCounters: 'budget_counters',
  usage: 'usage',
  requestLogs: 'request_logs',
  cache: 'cache_entries',
  audit: 'audit_logs',
  notifications: 'notifications',
  meta: 'system_meta',
} as const;

const ts = { createdAt: 'date', updatedAt: 'date' } as const;

export const SCHEMA: CollectionDef[] = [
  {
    name: C.users,
    fields: {
      username: 'string', email: 'string', name: 'string', role: 'string', status: 'string',
      passwordHash: 'text', mustChangePassword: 'bool', passwordChangedAt: 'date',
      mfaEnabled: 'bool', mfaSecretEnc: 'text', mfaRecoveryHashes: 'json',
      failedLogins: 'int', lockedUntil: 'date', lastLoginAt: 'date', lastLoginIp: 'string',
      inviteTokenHash: 'string', inviteExpiresAt: 'date', createdBy: 'string', ...ts,
    },
    unique: [['username'], ['email']],
    indexes: [['inviteTokenHash']],
  },
  {
    name: C.sessions,
    fields: {
      userId: 'string', tokenHash: 'string', csrfHash: 'string', stage: 'string', ip: 'string', userAgent: 'text',
      createdAt: 'date', lastSeenAt: 'date', expiresAt: 'date', revokedAt: 'date',
    },
    unique: [['tokenHash']],
    indexes: [['userId'], ['expiresAt']],
  },
  { name: C.settings, fields: { value: 'json', valueEnc: 'text', secret: 'bool', updatedBy: 'string', updatedAt: 'date' } },
  {
    name: C.providers,
    fields: {
      name: 'string', slug: 'string', type: 'string', presetId: 'string', baseUrl: 'string',
      config: 'json', secretsEnc: 'text', status: 'string', timeoutMs: 'int', maxRetries: 'int',
      lastTestAt: 'date', lastTestOk: 'bool', lastTestMessage: 'text', createdBy: 'string', ...ts,
    },
    unique: [['slug']],
  },
  {
    name: C.models,
    fields: {
      providerId: 'string', slug: 'string', providerModelId: 'string', displayName: 'string', type: 'string',
      status: 'string', contextWindow: 'int', maxOutputTokens: 'int', pricing: 'json', capabilities: 'json',
      tier: 'string', notes: 'text', ...ts,
    },
    unique: [['slug']],
    indexes: [['providerId']],
  },
  {
    name: C.pricingHistory,
    fields: { modelId: 'string', pricing: 'json', previous: 'json', changedBy: 'string', createdAt: 'date' },
    indexes: [['modelId', 'createdAt']],
  },
  {
    name: C.routes,
    fields: {
      slug: 'string', name: 'string', description: 'text', strategy: 'string', targets: 'json',
      autoConfig: 'json', retry: 'json', status: 'string', ...ts,
    },
    unique: [['slug']],
  },
  {
    name: C.apps,
    fields: {
      name: 'string', slug: 'string', description: 'text', owner: 'string', ownerEmail: 'string',
      status: 'string', settings: 'json', tags: 'json', ...ts,
    },
    unique: [['slug']],
  },
  {
    name: C.entities,
    fields: { name: 'string', type: 'string', email: 'string', description: 'text', status: 'string', ...ts },
    indexes: [['name']],
  },
  {
    name: C.apiKeys,
    fields: {
      name: 'string', appId: 'string', entityId: 'string', keyHash: 'string', prefix: 'string', last4: 'string',
      status: 'string', expiresAt: 'date', access: 'json', limits: 'json', ipAllowlist: 'json', metadata: 'json',
      createdBy: 'string', lastUsedAt: 'date', revokedAt: 'date', revokedBy: 'string', revokeReason: 'text',
      rotatedAt: 'date', rotationCount: 'int', ...ts,
    },
    unique: [['keyHash']],
    indexes: [['appId'], ['entityId'], ['status']],
  },
  {
    name: C.keyEvents,
    fields: { keyId: 'string', event: 'string', actorId: 'string', actorName: 'string', reason: 'text', createdAt: 'date' },
    indexes: [['keyId', 'createdAt']],
  },
  {
    name: C.prompts,
    fields: { slug: 'string', name: 'string', description: 'text', appId: 'string', labels: 'json', latestVersion: 'int', ...ts },
    unique: [['slug']],
  },
  {
    name: C.promptVersions,
    fields: {
      promptId: 'string', version: 'int', template: 'json', variables: 'json', changelog: 'text',
      createdBy: 'string', createdAt: 'date',
    },
    unique: [['promptId', 'version']],
  },
  {
    name: C.guardrails,
    fields: { name: 'string', description: 'text', status: 'string', isDefault: 'bool', config: 'json', ...ts },
  },
  {
    name: C.budgets,
    fields: {
      name: 'string', scope: 'json', period: 'string', amountUsd: 'number', action: 'string', thresholds: 'json',
      notifyEmails: 'json', status: 'string', createdBy: 'string', ...ts,
    },
    indexes: [['status']],
  },
  {
    name: C.budgetCounters,
    fields: {
      budgetId: 'string', periodKey: 'string', spentUsd: 'number', requests: 'int', notified: 'json',
      updatedAt: 'date', createdAt: 'date',
    },
    unique: [['budgetId', 'periodKey']],
  },
  {
    name: C.usage,
    fields: {
      ts: 'date', requestId: 'string', endpoint: 'string', appId: 'string', entityId: 'string', keyId: 'string',
      providerId: 'string', modelId: 'string', routeId: 'string', requestedModel: 'string',
      status: 'string', httpStatus: 'int', errorCode: 'string', errorMessage: 'text',
      inputTokens: 'int', outputTokens: 'int', cachedTokens: 'int', totalTokens: 'int',
      costUsd: 'number', inputCostUsd: 'number', outputCostUsd: 'number', savedUsd: 'number',
      latencyMs: 'int', ttftMs: 'int', cacheHit: 'bool', stream: 'bool', attempts: 'int',
      promptId: 'string', promptVersion: 'int', piiRedactions: 'int', guardrailFlags: 'json', tags: 'json',
      endUser: 'string', ip: 'string', tokensEstimated: 'bool',
    },
    indexes: [['ts'], ['appId', 'ts'], ['keyId', 'ts'], ['entityId', 'ts'], ['modelId', 'ts'], ['providerId', 'ts'], ['requestId']],
  },
  {
    name: C.requestLogs,
    fields: { ts: 'date', appId: 'string', bodyEnc: 'text', expiresAt: 'date' },
    indexes: [['expiresAt']],
  },
  {
    name: C.cache,
    fields: { appId: 'string', model: 'string', responseEnc: 'text', usage: 'json', createdAt: 'date', expiresAt: 'date', hits: 'int' },
    indexes: [['expiresAt'], ['appId']],
  },
  {
    name: C.audit,
    fields: {
      ts: 'date', seq: 'int', actorType: 'string', actorId: 'string', actorName: 'string', action: 'string',
      resourceType: 'string', resourceId: 'string', outcome: 'string', ip: 'string', userAgent: 'text',
      details: 'json', prevHash: 'string', hash: 'string', kid: 'string',
    },
    unique: [['seq']],
    indexes: [['ts'], ['action'], ['actorId'], ['resourceType', 'resourceId']],
  },
  {
    name: C.notifications,
    fields: {
      ts: 'date', event: 'string', channel: 'string', recipients: 'json', subject: 'text', status: 'string',
      error: 'text', relatedId: 'string',
    },
    indexes: [['ts']],
  },
  { name: C.meta, fields: { value: 'json', updatedAt: 'date' } },
];

export const SCHEMA_BY_NAME = new Map(SCHEMA.map((d) => [d.name, d]));
