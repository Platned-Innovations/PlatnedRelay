# Relay documentation

Relay is the internal LLM gateway: a single, secure, OpenAI-compatible API in front of every local and cloud model we use. Applications (Axiom, SCIC, Cleo, and future projects) call Relay instead of calling model providers directly, and Relay takes care of routing, metering, cost control, caching, PII protection, guardrails, prompt versioning and auditing.

| Guide | For | What it covers |
|---|---|---|
| [Getting started](getting-started.md) | Everyone | Run Relay locally, first sign-in, connect a provider, issue a key, make a call |
| [Integrating an application](api.md) | App developers | The public `/v1` API, SDK examples, streaming, embeddings, batch, Relay extensions, headers, errors |
| [Administration guide](admin-guide.md) | Relay admins | Apps, entities, keys, providers, models & pricing, routes, prompts, guardrails, spend caps, notifications, users, audit, reports |
| [Providers](providers.md) | Relay admins | Every provider type, presets, Azure OpenAI, local models, the custom HTTP adapter |
| [Configuration](configuration.md) | Operators | Environment variables (the minimal set) and every UI-managed setting |
| [Security](security.md) | Security reviewers, operators | Threat model, encryption, key handling, sessions, MFA, audit chain, key rotation, hardening checklist |
| [Architecture](architecture.md) | Engineers | Components, request pipeline, data model, database abstraction |
| [Scaling & performance](scaling.md) | Operators | Concurrency model, horizontal scaling, tuning |
| [Deploy with Docker](deployment-docker.md) | Operators | Image, compose files, PostgreSQL or MongoDB |
| [Deploy to Azure Web App](deployment-azure.md) | Operators | Bicep, Key Vault references, CI/CD, scaling, networking |
| [Operations](operations.md) | Operators | Health checks, backups, retention, monitoring, troubleshooting |
| [Admin API reference](admin-api.md) | Engineers | Every `/api/admin` endpoint |
| [Roadmap & market comparison](roadmap.md) | Product owners | How Relay compares with LiteLLM, Portkey, Helicone, Kong/Cloudflare AI gateways and what to build next |

## Key ideas in one minute

- **One public surface.** Client apps only ever talk to `https://<relay>/v1/...` with a Relay key (`Authorization: Bearer rly_...`). Provider API keys never leave Relay.
- **Keys belong to an app and an entity.** An *entity* is whoever uses the key: a developer, a hosted test environment, a service. It does not need to be a Relay user. Every request is metered against the key, its app, its entity, the provider and the model.
- **Nothing that carries history is deleted.** Keys are deactivated, reactivated, regenerated or permanently revoked, never deleted, so cost history stays intact.
- **Everything is configured in the UI and stored encrypted.** The only environment variables are the database connection and the master key.
