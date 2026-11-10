# Deploy with Docker

## Image

`Dockerfile` builds the API and the admin UI in a build stage and produces a small runtime image:

- `node:22-alpine`, runs as the unprivileged `node` user, `tini` as PID 1 (clean signal handling → usage buffer is flushed on stop)
- `RELAY_WORKERS=auto` (one worker per CPU), port 8080
- `HEALTHCHECK` on `/health/live`
- Works with a read-only root filesystem (compose files set `read_only: true`)

```bash
docker build -t relay-llm-gateway:1.0.0 .
docker run -d -p 8080:8080 \
  -e DB_TYPE=postgres \
  -e DATABASE_URL='postgres://relay:***@db-host:5432/relay?sslmode=require' \
  -e RELAY_MASTER_KEY='***' \
  --read-only --tmpfs /tmp --security-opt no-new-privileges \
  relay-llm-gateway:1.0.0
docker logs <container> | grep -A3 "Initial owner"   # first start on an empty DB only
```

## Compose

| File | Stack |
|---|---|
| `docker-compose.yml` | Relay + PostgreSQL 16 (+ `--profile ollama` for a local Ollama) |
| `docker-compose.mongo.yml` | Relay + MongoDB 7 |

```bash
cp .env.example .env    # set RELAY_MASTER_KEY and POSTGRES_PASSWORD / MONGO_PASSWORD
docker compose up -d --build
```

With the Ollama profile, add a provider in the UI with the **Ollama** preset and base URL `http://ollama:11434/v1`, then `docker compose exec ollama ollama pull llama3.1:8b`.

## Secrets

Prefer Docker/Kubernetes secrets or your orchestrator's secret store over plain environment variables in files. If you must use `.env`, restrict its permissions (`chmod 600`) and never commit it (it is git-ignored).

## TLS / reverse proxy

Terminate TLS at a reverse proxy (nginx, Traefik, Azure Front Door/App Gateway) and set `TRUST_PROXY=1`. For streaming, disable proxy buffering (Relay already sends `X-Accel-Buffering: no`) and set read timeouts of several minutes. Example nginx location:

```nginx
location / {
  proxy_pass http://relay:8080;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 900s;
  client_max_body_size 25m;
}
```

## Upgrades

Pull/build the new image and restart. Schema changes are applied automatically and additively at startup. Take a database backup before upgrading.
