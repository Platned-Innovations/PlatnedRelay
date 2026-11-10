# Architecture

```
            Client apps (Axiom, SCIC, Cleo, ...)          Admins (browser)
                     │  OpenAI SDK / HTTP                        │
                     ▼  Bearer rly_...                           ▼  session cookie + CSRF
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Relay (NestJS, Node.js)                                                      │
 │  /v1  ── GatewayController ─► GatewayService (pipeline below)                 │
 │  /api/admin ── AdminAuthGuard ─► Users, Apps, Keys, Providers, Models, Routes, │
 │                 Prompts, Guardrails, Budgets, Analytics, Audit, Settings       │
 │  /    ── React admin UI (static, served by the same process)                  │
 │                                                                              │
 │  CatalogService (in-memory snapshot of config, 15 s refresh)                  │
 │  UsageRecorder (write-behind buffer, bulk inserts every 1 s)                  │
 │  BudgetsService · ResponseCache · Notifications (SMTP / Graph / webhooks)     │
 │  AuditService (HMAC hash chain) · CryptoService (AES-GCM, HMAC, HKDF)         │
 │  Store abstraction ─► PostgresStore | MongoStore                              │
 └───────────────┬───────────────────────────────────────┬──────────────────────┘
                 ▼                                       ▼
        PostgreSQL or MongoDB              OpenAI · Anthropic · Gemini · Azure OpenAI ·
                                           DeepSeek · Mistral · ... · Ollama/vLLM · custom
```

## Request pipeline (`POST /v1/chat/completions`)

1. **Authenticate** the Relay key (HMAC lookup, cached 15 s): status, expiry, app and entity active, IP allowlist. Failed attempts are throttled per IP.
2. **Limits**: key RPM, app RPM, key TPM, key concurrency.
3. **Prompt template** (optional `relay.prompt`): resolve version/label, render variables, prepend messages.
4. **Guardrails**: merge default + app policies; block (patterns, keywords, injection, PII, size) or redact/mask PII; cap output tokens; enforce key tokens-per-request.
5. **Resolve model**: model slug, bare upstream id or route → ordered candidate list (fallback / load balance / cheapest / auto), filtered by key and app permissions and provider/model status.
6. **Cache** lookup (per app, exact match on the normalised request).
7. For each candidate: **spend-cap check** (skip target if a blocking cap is exhausted) → **adapter call** with retries (exponential backoff + jitter) → on retryable/auth/not-found errors **fall back** to the next candidate.
8. **Output**: output guardrails, restore masked PII (also streaming-safe), headers.
9. **Meter**: compute cost from the model's pricing (uncached/cached/cache-write/output/per-request), enqueue the usage record, update spend-cap counters and threshold notifications, add to TPM window, optionally store encrypted bodies, populate cache.

Streaming: the SSE response starts only after the first upstream chunk arrives, so fallback is still possible for connection/HTTP errors. Client disconnects abort the upstream call.

## Data model

| Collection/table | Purpose |
|---|---|
| `users`, `sessions` | Admin accounts (Argon2id, TOTP), server-side sessions |
| `apps`, `entities`, `api_keys`, `key_events` | Consumers, key holders, keys (HMAC only), key lifecycle history |
| `providers`, `models`, `pricing_history` | Provider endpoints (secrets encrypted), model catalog, versioned prices |
| `routes`, `prompts`, `prompt_versions`, `guardrail_policies` | Routing, prompt management, guardrails |
| `budgets`, `budget_counters` | Spend caps, atomic per-period counters |
| `usage`, `request_logs`, `cache_entries` | Metering (one row per request), encrypted bodies, encrypted response cache |
| `audit_logs`, `notifications`, `settings`, `system_meta` | Audit chain, delivery log, UI-managed settings, install info/locks |

## Database abstraction

`src/database/store.ts` defines a small engine-neutral API (CRUD, filters with `$in/$gt/$ilike/$or...`, atomic `incrementUnique`, `aggregate` with group-by, time buckets and metrics). `src/database/schema.ts` is the single schema registry; at startup each adapter creates missing tables/columns/indexes (PostgreSQL) or collections/indexes (MongoDB). Schema evolution is additive and automatic; no migration tool is needed for new fields. Every feature therefore behaves identically on both engines (the e2e suite runs against both).

## Source layout

```
src/
  main.ts                 bootstrap, security headers, static UI, cluster mode
  app.module.ts           DI wiring
  config/env.ts           the few environment variables
  database/               Store interface, schema, PostgreSQL + MongoDB adapters
  common/                 crypto, utilities, exception filter
  auth/ users/            admin auth (sessions, MFA, CSRF, roles) and user management
  catalog/                in-memory configuration snapshot for the hot path
  providers/              adapters (openai, azure-openai, anthropic, gemini, custom), presets, provider/model APIs
  gateway/                /v1 controller, pipeline, router, budgets, cache, usage recorder
  guardrails/ prompts/ policies/ apps/ keys/ analytics/ audit/ settings/ notifications/ system/
web/                      React admin UI (Vite)
test/                     unit tests (vitest) and e2e smoke suite
deploy/azure/             Bicep template
```
