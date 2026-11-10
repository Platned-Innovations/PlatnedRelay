# Deploy to Azure Web App

Recommended: **Azure App Service (Linux) – Web App for Containers**, with secrets in **Key Vault** referenced through the app's managed identity, images in **Azure Container Registry**, and **Azure Database for PostgreSQL Flexible Server** (or MongoDB via Azure Cosmos DB for MongoDB vCore / MongoDB Atlas).

## 1. Provision infrastructure (Bicep)

```bash
az group create -n rg-relay -l westeurope
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
echo "$MASTER_KEY"   # store an offline copy in your password safe NOW

az deployment group create -g rg-relay -f deploy/azure/main.bicep \
  -p name=relay masterKey="$MASTER_KEY" postgresAdminPassword='<strong-password>' instanceCount=2
```

`deploy/azure/main.bicep` creates:

| Resource | Notes |
|---|---|
| App Service plan (Linux, P1v3, 2 instances) | Scale up/out as needed |
| Web App | HTTPS only, TLS 1.2+, FTPS disabled, Always On, health check `/health`, system-assigned identity, no ARR affinity |
| Key Vault (RBAC, soft delete, purge protection) | Secrets `relay-master-key`, `relay-database-url`; the Web App gets *Key Vault Secrets User* |
| App settings | `DATABASE_URL` and `RELAY_MASTER_KEY` are `@Microsoft.KeyVault(...)` references, plus `DB_TYPE`, `TRUST_PROXY=1`, `RELAY_WORKERS=auto`, `WEBSITES_PORT=8080` |
| Container Registry | The Web App pulls with its managed identity (*AcrPull*) |
| PostgreSQL Flexible Server 16 + database `relay` | `sslmode=require`; firewall allows Azure services — switch to VNet integration + private access for production |
| Log Analytics + diagnostic settings | Console, HTTP and platform logs |

MongoDB instead: `createPostgres=false dbType=mongodb databaseUrl='mongodb+srv://...'`. Relay's reports need `$dateTrunc` (MongoDB 5.0+); confirm your Cosmos DB tier supports it before choosing it.

## 2. Build and deploy the image

Manual:

```bash
ACR=$(az deployment group show -g rg-relay -n main --query properties.outputs.acrLoginServer.value -o tsv)
APP=$(az deployment group show -g rg-relay -n main --query properties.outputs.siteName.value -o tsv)
az acr build -r ${ACR%%.*} -t relay:1.0.0 .
az webapp config container set -g rg-relay -n $APP --container-image-name $ACR/relay:1.0.0
az webapp log tail -g rg-relay -n $APP | grep -A3 "Initial owner"
```

CI/CD: `.github/workflows/azure-webapp.yml` runs typecheck + unit tests + UI build, builds the image with ACR Tasks and deploys it, then waits for `/health`. Configure GitHub OIDC (federated credential) and set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` secrets and `AZURE_ACR_NAME`, `AZURE_WEBAPP_NAME` variables.

## 3. After the first start

1. Read the initial owner credentials from the log stream (printed once).
2. Sign in at `https://<app>.azurewebsites.net`, change the password, enable MFA.
3. Settings → Gateway → **Public base URL** = your custom domain (used in emails).
4. Settings → Security → admin IP allowlist (corporate egress IPs / VPN), require MFA.
5. Settings → Notifications → Microsoft Graph (app registration with `Mail.Send` application permission, restricted with an application access policy) or SMTP.

## Alternative: Web App with the Node runtime (no container)

Create a Linux Web App with runtime `NODE|22-lts`, then deploy a zip containing `package.json`, `dist/`, `web/dist/` and production `node_modules`:

```bash
npm ci && npm --prefix web ci && npm run build && npm prune --omit=dev
zip -r relay.zip package.json dist web/dist node_modules
az webapp deploy -g rg-relay -n <app> --src-path relay.zip --type zip
az webapp config set -g rg-relay -n <app> --startup-file "node dist/main.js"
```

Set the same app settings (Key Vault references) as in the Bicep template. Disable Oryx build (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`) since the package is prebuilt.

## Networking options

- **Keep the admin console private**: put Azure Front Door or Application Gateway (WAF) in front and only route `/v1/*` (and `/health`) from the internet; reach the console via VPN/private endpoint. Or use App Service access restrictions (`allowedCidrs` parameter) plus Relay's admin IP allowlist.
- **Private database**: VNet-integrate the Web App and use PostgreSQL private access / private endpoints.
- **Outbound to providers**: if you need fixed egress IPs (provider allowlists), use a NAT Gateway on the integration subnet.

## Scaling

Scale out (instances) for throughput and availability; `RELAY_WORKERS=auto` uses all cores per instance. See [scaling.md](scaling.md) for per-process rate-limit semantics. Configure autoscale on CPU (e.g. > 60%) and HTTP queue length.
