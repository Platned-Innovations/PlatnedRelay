# Configuration

## Environment variables (deliberately minimal)

Only values needed before the database is reachable, or that must never live in the database, are environment variables.

| Variable | Required | Description |
|---|---|---|
| `DB_TYPE` | yes | `postgres` or `mongodb` |
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/db?sslmode=require` or `mongodb://user:pass@host:27017/db` |
| `RELAY_MASTER_KEY` | yes | 32 random bytes, base64. Root of all encryption/HMAC keys. Generate with `npm run gen:key`. Keep it in Key Vault / Docker secrets and back it up offline. |
| `RELAY_MASTER_KEY_PREVIOUS` | no | Previous master key during rotation (decrypt/verify only). See [security.md](security.md#master-key-rotation). |
| `PORT` | no | HTTP port (default 8080; `WEBSITES_PORT` also honoured) |
| `TRUST_PROXY` | no | Proxy hops in front of Relay (e.g. `1` on Azure App Service) so client IPs, IP allowlists and rate limits are correct |
| `RELAY_WORKERS` | no | Worker processes per container: number or `auto` (CPU count). Default 1 from source, `auto` in the Docker image |
| `LOG_LEVEL` | no | `debug` for verbose startup logs |

PostgreSQL connections use TLS automatically for Azure (`*.postgres.database.azure.com`) or when `sslmode=require|verify-*` is in the URL.

## Settings managed in the UI (stored in the database)

Secrets in settings (SMTP password, Graph client secret) are encrypted with the master key and returned masked.

### Security (owner only)

| Setting | Default | |
|---|---|---|
| Session idle timeout | 30 min | Sign-out after inactivity |
| Session absolute lifetime | 12 h | |
| Max failed sign-ins / lockout | 5 / 15 min | Lockout triggers a security alert |
| Password minimum length | 12 | Plus 3 of 4 character classes, not containing the username |
| Require MFA | off | When on, users must enrol before using the console |
| Admin IP allowlist | empty | Restricts `/api/admin` (incl. sign-in) to IPs/CIDRs |
| Invite link validity | 72 h | |

### Gateway

| Setting | Default | |
|---|---|---|
| Public base URL | empty | Used in invite/reset links (e.g. `https://relay.example.com`) |
| Request timeout | 120 s | Per upstream call (providers can override) |
| Default max retries | 2 | Retries for retryable upstream errors |
| Default cache TTL | 3600 s | |
| Store request bodies | off | Global default; apps can override |
| Request body retention | 30 days | |
| Usage retention | 730 days | `0` = keep forever |
| Audit retention | 2555 days | `0` = keep forever |
| Key expiry warnings | 14, 3, 1 days | |
| Expose cost headers | on | `x-relay-cost-usd` |
| Default key RPM | 0 (unlimited) | Applied to keys without their own RPM |

### Routing

Defaults for `auto` routes: long-context threshold (2000 tokens) and "strong" keywords.

### Notifications

Channel (none/SMTP/Microsoft Graph), sender, admin recipients, per-event toggles, webhooks. See [admin-guide.md](admin-guide.md#notifications).
