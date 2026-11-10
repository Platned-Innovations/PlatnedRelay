# Scaling & performance

Many applications call Relay at the same time, so the request path is built for high concurrency.

## How a single instance handles many parallel requests

- **Fully asynchronous I/O.** Node.js handles thousands of concurrent upstream calls on one event loop; time spent waiting on providers costs no threads.
- **No database round-trips on the hot path in the common case.** Keys (5 s), configuration snapshot (providers, models, routes, apps, guardrails, budgets: 15 s, refreshed in the background, stale-while-revalidate) and spend-cap totals (5 s) are cached in memory.
- **Write-behind metering.** Usage records go into an in-memory buffer flushed in bulk every second (or every 500 records), so requests never wait on analytics writes. The buffer is drained on graceful shutdown and retried if the DB is briefly unavailable.
- **No global locks.** Per-request state lives on the stack; rate limiters and counters are lock-free in-memory maps.
- **Streaming without buffering**, with client-disconnect propagation to cancel upstream work.
- **HTTP server tuned for long requests**: no request timeout (streams can last minutes), keep-alive 65 s (above typical load-balancer idle timeouts).
- **Batch endpoint** (`/v1/batch`) fans out up to 100 requests with bounded concurrency.

Measured in the e2e suite: 200 simultaneous chat requests against a provider with 50 ms latency complete in ~0.5 s on one process (PostgreSQL and MongoDB alike).

## Scaling out

1. **More cores per container**: `RELAY_WORKERS=auto` (default in the Docker image) forks one worker per CPU sharing the port.
2. **More instances**: run N containers / App Service instances behind a load balancer. Relay is stateless apart from short-lived caches; no sticky sessions are needed (admin sessions are in the DB).

| Concern | Behaviour with many instances |
|---|---|
| Rate limits (RPM/TPM/concurrency) | Enforced **per process**. Effective cluster limit ≈ limit × processes. Divide limits accordingly, or front Relay with a gateway that enforces global limits. |
| Spend caps | Counters are atomic in the DB. New totals are pushed instantly to every worker in the same container; other instances refresh every 5 s, so concurrent bursts across instances can overshoot a cap slightly (bounded by traffic in that window). |
| Key revocation / deactivation | Immediate on every worker of the container that handled the change; other instances within 5 s (key cache TTL). |
| Config changes | Immediate on every worker of the container (blocking reload); other instances within 15 s. |
| Response cache | Shared through the DB (encrypted); each process also keeps an LRU of 5,000 entries. |
| Audit chain | Linearised by a unique sequence index with retry. |
| Maintenance jobs | Run by one instance at a time (DB lease). |
| Initial admin creation | Guarded by a DB lock. |

## Database sizing

The `usage` table/collection grows by one row per request (≈1 KB). At 1M requests/day plan ~1 GB/day before indexes; set **usage retention** accordingly and use reports/CSV exports for long-term archives. Indexes exist on `ts` and on `(dimension, ts)` for every reporting dimension. For PostgreSQL at very high volume consider partitioning `usage` by month (the adapter only issues standard SQL against the table name).

Connection pools: 20 connections per process (PostgreSQL and MongoDB). With `RELAY_WORKERS=auto` on a 4-core instance and 3 instances that is up to 240 connections: size the DB (or use PgBouncer in transaction mode) accordingly.

## Tuning checklist

- Use `RELAY_WORKERS=auto` and at least 2 instances for availability.
- Set provider timeouts and retries per provider; configure fallback routes for critical apps.
- Enable caching for apps with repetitive prompts (classification, extraction).
- Keep request-body logging off for high-volume apps.
- Monitor average/max latency and error rate on the dashboard and reports; add a fallback target if a provider is unstable.
