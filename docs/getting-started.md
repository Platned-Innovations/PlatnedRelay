# Getting started

## Prerequisites

- Node.js 20.12+ (22 recommended) **or** Docker
- PostgreSQL 13+ **or** MongoDB 6+ (5.0+ works; `$dateTrunc` is required for reports)

## Option A: Docker (fastest)

```bash
cp .env.example .env
# set RELAY_MASTER_KEY (generate one below) and POSTGRES_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose up -d --build
docker compose logs relay | grep -A3 "Initial owner"
```

Open http://localhost:8080. MongoDB instead: `docker compose -f docker-compose.mongo.yml up -d --build`.

## Option B: from source

```bash
npm install
npm --prefix web install
cp .env.example .env              # set DB_TYPE, DATABASE_URL, RELAY_MASTER_KEY
npm run build                     # builds API (dist/) and admin UI (web/dist)
npm start                         # reads .env from the working directory
```

For development, run `npm run dev` (API with watch) and `npm run dev:web` (Vite on :5173, proxying `/api` and `/v1` to the API on :8080; set `RELAY_API_URL=http://localhost:<port>` if your API runs elsewhere).

## First sign-in

When Relay connects to an empty database it creates an **owner** account with a generated username and password and prints them **once** to the server log:

```
========================================================================
  RELAY - NEW DATABASE INITIALISED
  Initial owner account (shown ONCE - store it securely):
    Username: admin-k3x9q
    Password: 7v#P...
```

Missed the banner? Run `npm run admin -- reset` (or `docker compose exec relay node dist/cli.js reset`) to issue a new one-time password.

1. Sign in. You will be forced to change the password.
2. Go to **Users**, edit your account and set your real email address.
3. Go to **Profile** and enable MFA (recommended; can be made mandatory under Settings → Security).
4. Invite other admins from **Users** (they get an email if notifications are configured; otherwise copy the invite link).

## Connect your first provider

1. **Providers → Add provider**, pick a preset (OpenAI, Anthropic, Gemini, Azure OpenAI, DeepSeek, Ollama, ...).
2. Paste the provider API key. It is encrypted immediately and never shown again (only the last 4 characters).
3. Keep **Import preset models** ticked to get the model catalog with default pricing.
4. Click **Test connection**.
5. Check **Models & Pricing** and adjust prices to your contract. Seeded prices are defaults; verify them with the provider.

## Issue a key and make a call

1. **Apps → New app** (e.g. `SCIC`).
2. **API Keys → Create key**: choose the app, choose or create the entity (e.g. "Jane – developer" or "SCIC test environment"), optionally set an expiry date (it cannot be changed later), restrict providers/models, set limits and a spend cap.
3. Copy the secret: it is shown **only once**.

```bash
curl https://relay.example.com/v1/chat/completions \
  -H "Authorization: Bearer rly_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4.1-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Any OpenAI SDK works by changing the base URL. See [api.md](api.md).

## Run the tests

```bash
npm test                         # unit tests
node test/e2e/mock-llm.js &      # mock provider on :18080
# start Relay against a FRESH database, then:
node test/e2e/smoke.mjs http://localhost:8080 <initial-username> <initial-password>
```
