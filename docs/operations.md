# Operations

## Health endpoints

| Endpoint | Use |
|---|---|
| `GET /health/live` | Liveness: process is up (Docker `HEALTHCHECK`) |
| `GET /health` | Readiness: database reachable → `200 {"status":"ok"}` or `503` (Azure health check, load balancers) |

## Logs

Relay logs to stdout/stderr (warnings and errors by default; `LOG_LEVEL=debug` for verbose). Notable messages: provider failures, usage buffer flush failures (DB unreachable), maintenance results. Request-level detail lives in the **Requests** page, not in logs, so prompts never end up in log pipelines.

## Background jobs

Every 10 minutes one instance (DB lease) runs:
- delete expired cache entries, stored request bodies past retention, old sessions;
- delete usage and audit records past their retention (if retention > 0);
- prune notification log entries older than 180 days;
- send key-expiry warnings (once per threshold per key).

## Backups

Back up the database and, separately, the master key.

- PostgreSQL: Azure Flexible Server automated backups (PITR) or `pg_dump -Fc relay`.
- MongoDB: `mongodump --db relay` or managed backups.
- The master key is required to use any backup. Store it apart from database backups.

Restore test: restore into a new database, start Relay with the same master key, sign in, run **Audit → Verify integrity** and **Providers → Test connection**.

## Monitoring suggestions

- Availability: `/health` from Azure Monitor / uptime checks.
- Error rate and spend: dashboard; spend-cap and provider-failure notifications; webhooks into Teams/Slack.
- Audit: periodic JSON export to the SIEM; alert on `auth.login` failures and `security.alert` notifications.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401 invalid_api_key` | Key inactive/expired/revoked? Wrong environment? Key detail → events. |
| `403 ip_not_allowed` | Key IP allowlist; `TRUST_PROXY` set correctly behind a proxy? |
| `404 model_not_found` | Model/route slug, model or provider disabled, app allowed-models list. |
| `429 budget_exceeded` | Spend caps page; raise the cap or reset the period. |
| `429 rate_limit_exceeded` | Key/app RPM, TPM, concurrency (per process, see scaling.md). |
| `502 upstream_error` | Provider test connection; provider status; credentials (upstream 401/403 are reported as 502 to clients). |
| Streaming stalls behind a proxy | Disable proxy buffering, increase read timeouts. |
| Usage missing on dashboard | Records are flushed every second; check logs for "Flush failed". |
| Initial credentials lost / owner locked out | On the server: `npm run admin -- list` then `npm run admin -- reset [username]` (new one-time password, unlocks the account, revokes sessions, audited). In Docker: `docker compose exec relay node dist/cli.js reset`. |

## Upgrades

Rolling restarts are safe: schema changes are additive and applied at startup; the usage buffer is flushed on SIGTERM. Take a backup first.
