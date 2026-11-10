// Relay on Azure App Service (Linux, container) with Key Vault-held secrets.
//
// Creates: Log Analytics, App Service plan, Web App (system-assigned identity),
// Key Vault (RBAC) with the master key + database URL, Azure Container Registry,
// and optionally Azure Database for PostgreSQL Flexible Server.
//
//   az deployment group create -g <rg> -f deploy/azure/main.bicep \
//     -p name=relay masterKey=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
//        postgresAdminPassword='<strong password>'
//
// To use MongoDB (e.g. Azure Cosmos DB for MongoDB vCore) set createPostgres=false,
// dbType=mongodb and pass databaseUrl.

@description('Base name for all resources')
param name string = 'relay'
param location string = resourceGroup().location
@description('App Service plan SKU. P1v3+ recommended for production.')
param planSku string = 'P1v3'
@description('Number of instances (horizontal scale-out).')
param instanceCount int = 2
@secure()
@description('32-byte base64 master key (npm run gen:key). Store a copy offline.')
param masterKey string
@allowed(['postgres', 'mongodb'])
param dbType string = 'postgres'
param createPostgres bool = true
@secure()
param postgresAdminPassword string = ''
@secure()
@description('Required when createPostgres=false.')
param databaseUrl string = ''
@description('Container image, e.g. <acr>.azurecr.io/relay:latest. Leave default until the first image push.')
param image string = 'mcr.microsoft.com/appsvc/staticsite:latest'
@description('Optional CIDRs allowed to reach the site at all (App Service access restrictions). Empty = public.')
param allowedCidrs array = []

var suffix = uniqueString(resourceGroup().id, name)
var pgServerName = '${name}-pg-${suffix}'
var pgUrl = 'postgres://relayadmin:${uriComponent(postgresAdminPassword)}@${pgServerName}.postgres.database.azure.com:5432/relay?sslmode=require'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs-${suffix}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('${name}acr${suffix}', '-', '')
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = if (createPostgres && dbType == 'postgres') {
  name: pgServerName
  location: location
  sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' }
  properties: {
    version: '16'
    administratorLogin: 'relayadmin'
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 64, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = if (createPostgres && dbType == 'postgres') {
  parent: pg
  name: 'relay'
}

// Allows Azure services (the Web App) to connect. Prefer VNet integration + private access for production.
resource pgFw 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = if (createPostgres && dbType == 'postgres') {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('${name}-kv-${suffix}', 24)
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
  }
}

resource secretMaster 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'relay-master-key'
  properties: { value: masterKey }
}

resource secretDb 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'relay-database-url'
  properties: { value: createPostgres && dbType == 'postgres' ? pgUrl : databaseUrl }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${name}-plan'
  location: location
  kind: 'linux'
  sku: { name: planSku, capacity: instanceCount }
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: '${name}-${suffix}'
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'DOCKER|${image}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/health'
      ipSecurityRestrictions: [for (cidr, i) in allowedCidrs: { ipAddress: cidr, action: 'Allow', priority: 100 + i, name: 'allow-${i}' }]
      appSettings: [
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'PORT', value: '8080' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'TRUST_PROXY', value: '1' }
        { name: 'RELAY_WORKERS', value: 'auto' }
        { name: 'DB_TYPE', value: dbType }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(SecretUri=${secretDb.properties.secretUri})' }
        { name: 'RELAY_MASTER_KEY', value: '@Microsoft.KeyVault(SecretUri=${secretMaster.properties.secretUri})' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
      ]
    }
  }
}

// Web App identity: read Key Vault secrets + pull images from ACR.
resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, site.id, 'kv-secrets-user')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, site.id, 'acr-pull')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'to-log-analytics'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output siteName string = site.name
output siteUrl string = 'https://${site.properties.defaultHostName}'
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = kv.name
