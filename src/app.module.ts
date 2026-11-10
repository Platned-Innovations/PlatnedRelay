import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { loadEnv } from './config/env';
import { Store } from './database/store';
import { SCHEMA } from './database/schema';
import { PostgresStore } from './database/postgres.store';
import { MongoStore } from './database/mongo.store';
import { CryptoService } from './common/crypto.service';
import { AllExceptionsFilter } from './common/exception.filter';
import { SettingsService } from './settings/settings.service';
import { SettingsController } from './settings/settings.controller';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { NotificationsService } from './notifications/notifications.service';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { AdminAuthGuard } from './auth/auth.guard';
import { UsersController, UsersService } from './users/users.controller';
import { CatalogService } from './catalog/catalog.service';
import { ProvidersController, ProvidersService } from './providers/providers.controller';
import { ModelsController, ModelsService } from './providers/models.controller';
import { AppsController, AppsService } from './apps/apps.controller';
import { KeysController, KeysService } from './keys/keys.controller';
import { PoliciesController, PoliciesService } from './policies/policies.controller';
import { PromptsController, PromptsService } from './prompts/prompts.controller';
import { BudgetsService } from './gateway/budgets.service';
import { ResponseCacheService } from './gateway/response-cache.service';
import { UsageRecorder } from './gateway/usage-recorder.service';
import { GatewayService } from './gateway/gateway.service';
import { GatewayController } from './gateway/gateway.controller';
import { AnalyticsController, AnalyticsService } from './analytics/analytics.controller';
import { MaintenanceService } from './system/maintenance.service';
import { BootstrapService } from './system/bootstrap.service';
import { HealthController } from './system/health.controller';

const storeProvider = {
  provide: Store,
  useFactory: async (): Promise<Store> => {
    const env = loadEnv();
    const store = env.dbType === 'mongodb' ? new MongoStore(env.databaseUrl) : new PostgresStore(env.databaseUrl);
    await store.init(SCHEMA);
    return store;
  },
};

@Global()
@Module({
  controllers: [
    GatewayController, HealthController, AuthController, UsersController, ProvidersController, ModelsController, AppsController,
    KeysController, PoliciesController, PromptsController, AnalyticsController, AuditController, SettingsController,
  ],
  providers: [
    storeProvider,
    { provide: CryptoService, useFactory: () => new CryptoService() },
    SettingsService, AuditService, NotificationsService, AuthService, UsersService, CatalogService, ProvidersService, ModelsService,
    AppsService, KeysService, PoliciesService, PromptsService, BudgetsService, ResponseCacheService, UsageRecorder, GatewayService,
    AnalyticsService, MaintenanceService, BootstrapService,
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
