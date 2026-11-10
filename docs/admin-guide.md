# Administration guide

Roles: **owner** (everything, incl. security settings, owner accounts, MFA resets, secret re-encryption), **admin** (manage all gateway configuration and users except owners), **viewer** (read-only dashboards, reports, configuration). Every change is written to the tamper-evident [audit log](#audit-log).

## Apps

An app is a consuming system (Axiom, SCIC, Cleo...). App settings:

| Setting | Effect |
|---|---|
| Status | Disabled apps reject all their keys immediately |
| Cache enabled / TTL | Exact-match response cache for this app (never shared across apps) |
| Log request bodies | Store encrypted prompts/responses for debugging (off by default; retention under Settings → Gateway) |
| Guardrail policies | Policies applied to every request of the app (in addition to default policies) |
| Allowed models | Optional allowlist; empty = any model the key permits |
| Default model | Used when a request omits `model` |
| RPM | App-wide requests/minute cap across all keys |
| Owner email | Receives spend-cap and key-expiry notifications for the app |

## Entities

An entity is *who or what* uses a key: a developer, a hosted environment ("SCIC – UAT"), a service, a team. Entities are not Relay users and need no login. Costs are reported per entity across all apps, so the same developer working on two apps appears once. Disabling an entity disables all its keys.

## API keys

Create from **API Keys → Create key**:

- **App** and **entity** (pick or create inline). Both are fixed after creation.
- **Expiry date** (optional). It is **immutable**: to extend access, issue a new key. Holders get warnings before expiry (Settings → Gateway → key expiry warning days).
- **Access**: *all* or *restricted* to selected providers, models and/or routes. Allowing a route allows the models behind it.
- **Limits**: requests/minute, tokens/minute, max tokens per request, max concurrent requests.
- **IP allowlist**: IPs or IPv4 CIDRs; empty = anywhere.
- **Metadata**: free key/values (cost centre, ticket...).
- **Spend cap** (optional): creates a key-scoped cap directly.

The secret (`rly_...`) is displayed **once**. Relay stores only an HMAC of it.

Lifecycle (nothing is ever deleted, so cost history stays linked):

| Action | Result | Reversible |
|---|---|---|
| Deactivate | Key rejected until reactivated | Yes |
| Reactivate | Active again (not possible once expired) | — |
| Regenerate | New secret for the **same** key record; the old secret stops working immediately; history kept | — |
| Revoke | Permanently disabled; cannot be reactivated, edited or regenerated | **No** |

Name, access, limits, IP allowlist and metadata remain editable on active/inactive keys. Each key has an event history (created, regenerated, revoked...).

## Providers

See [providers.md](providers.md). Provider API keys are encrypted with AES-256-GCM and never returned by the API. Use **Test connection** after changes. Disabling a provider removes its models from routing immediately.

## Models & pricing

Each model has a slug (what clients use, default `<provider-slug>/<model-id>`), the upstream model id (deployment name for Azure), type (chat/embedding), tier (cheap/standard/strong, used by auto routing), context window, max output, capabilities and **pricing per 1M tokens**:

| Price | Applied to |
|---|---|
| Input | Uncached prompt tokens |
| Cached input | Prompt tokens served from the provider's prompt cache |
| Cache write | Tokens written to the provider's prompt cache (Anthropic) |
| Output | Completion tokens (including reasoning tokens) |
| Per request | Flat fee per call (optional) |

Prices are fully editable; every change is versioned in **pricing history**. Each usage record stores the cost computed at request time, so changing a price never rewrites history.

Seeded prices are list prices known at build time. **Verify them** against your provider contracts.

## Routes

A route is a virtual model name with a strategy:

| Strategy | Behaviour |
|---|---|
| Fallback | Try targets in order; move on when a target fails (5xx, timeout, 429, auth/model errors) or is blocked by a spend cap |
| Load balance | Weighted random first choice, remaining targets as fallbacks |
| Cheapest | Order targets by price (input + output) |
| Auto (cheap vs strong) | Classify the request: long context (> threshold tokens), "strong" keywords, multi-step tool use or large code → strong models first, otherwise cheap models first; the other tier is the fallback |

Retries: each target is retried with exponential backoff for retryable errors (provider `maxRetries`, default from Settings → Gateway) before falling back.

## Prompts

Managed prompt templates with immutable versions and movable labels (`production`, `staging`, or your own). Apps reference a prompt by slug and label, so you can publish a new version, point `staging` at it, test, then move `production`, without app redeploys. Variables use `{{name}}`; missing variables are rejected. Usage records keep the prompt id and version, so reports can compare versions. A prompt can be restricted to one app.

## Guardrails

Policies combine:

- **PII**: `off`, `redact` (`[EMAIL]`), `mask_restore` (model sees `[EMAIL_1]`, the response is restored for the caller, including streamed responses), `block`. Entities: email, phone, credit card (Luhn-checked), US SSN, IBAN, IP address, secrets (OpenAI/Anthropic/AWS/GitHub/Slack/Google/Relay keys).
- **Blocked patterns** (regex) and **keywords** on user/tool input.
- **Prompt injection** heuristics: `flag` (recorded in usage) or `block`.
- **Max input tokens** (estimated) and **max output tokens** (caps `max_tokens`).
- **Output blocked patterns** (non-streaming responses are withheld with 422).

Policies marked **default** apply to every app; others are attached per app. When several apply, the strictest setting wins. Use **Test** to try a policy on sample text. Two policies are created on first run: *Baseline protection* (default: redacts secrets, flags injection) and *Strict PII (reversible)*.

## Spend caps

A cap has a **scope** made of any combination of app, entity, key, provider and model (empty scope = global), a **period** (daily, ISO weekly, monthly — UTC — or lifetime total), an amount in USD, an **action** and notification thresholds.

Examples:
- *SCIC monthly*: app = SCIC, monthly, $500, block.
- *Jane on Claude*: entity = Jane, provider = Anthropic, weekly, $50, notify.
- *Test env – GPT-5*: key = SCIC-UAT, model = gpt-5, daily, $5, block.

`block` rejects matching requests once the period total reaches the cap (`429 budget_exceeded`); for route requests Relay first tries other targets not covered by the cap. `notify` only alerts. Thresholds (default 50/80/100%) trigger one notification each per period to the cap's emails, the app owner, the entity email and admin recipients. **Reset** clears the current period's counter.

## Notifications

Settings → Notifications. Channels: **SMTP** or **Microsoft Graph** (app registration with `Mail.Send` application permission; use an Exchange application access policy to limit which mailbox it can send as). All credentials are stored encrypted. Events: user onboarding, password reset, spend cap warning/reached, key created/expiring/revoked, provider failure, security alerts (account lockout). Webhooks (JSON, Slack, Teams) can subscribe to the same events. Use **Send test email**; the delivery log shows every attempt.

## Users

Invite admins by username, email, name and role. They receive a one-time link (valid 72h by default) to set their password; if email is not configured, copy the link from the UI. Accounts lock after repeated failed sign-ins (configurable). Owners can reset another user's MFA. Users are disabled, never deleted, so audit attribution remains.

## Dashboards and reports

- **Dashboard**: spend, requests, tokens, error and cache-hit rates, latency, savings, trends and top apps/models/providers/entities/keys for any period.
- **Reports**: group by any combination of app, entity, key, provider, model, route, status, endpoint, end user, optionally per hour/day/week/month; export CSV.
- **Requests**: every call with status, tokens, cost, latency, cache, attempts, guardrail flags; stored bodies (if enabled) for admins.

## Audit log

Every admin action, sign-in (success and failure), key lifecycle event, setting change and system event is recorded with actor, IP, user agent and before/after details (secrets redacted). Entries form an HMAC hash chain keyed by the master key: **Verify integrity** detects any modified, deleted or re-ordered entry. Export JSON for your SIEM.
