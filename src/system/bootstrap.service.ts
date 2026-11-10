import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/security';
import { SYSTEM_ACTOR } from '../common/util';

/**
 * First-run initialisation. When an empty database is detected Relay creates an
 * owner account with a generated username and password, prints the credentials
 * once to the server log and forces a password change at first sign-in.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Bootstrap');

  constructor(private readonly store: Store, private readonly audit: AuditService) {}

  async onApplicationBootstrap() {
    if (!(await this.store.findById(C.meta, 'install'))) {
      try {
        await this.store.insert(C.meta, { id: 'install', value: { installedAt: new Date().toISOString(), database: this.store.kind }, updatedAt: new Date() });
      } catch {
        /* another worker won the race */
      }
    }
    if ((await this.store.count(C.users)) > 0) return;
    // Only one process/instance may create the initial admin (insert on a fixed id is the lock).
    const lock = await this.store.findById<any>(C.meta, 'lock:bootstrap');
    if (lock && Date.now() - new Date(lock.updatedAt).getTime() < 60_000) return;
    if (lock) await this.store.deleteById(C.meta, 'lock:bootstrap');
    try {
      await this.store.insert(C.meta, { id: 'lock:bootstrap', value: {}, updatedAt: new Date() });
    } catch {
      return;
    }
    if ((await this.store.count(C.users)) > 0) return;

    const username = `admin-${CryptoService.randomToken(4).replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toLowerCase() || 'relay'}`;
    const password = CryptoService.generatePassword(20);
    try {
      await this.store.insert(C.users, {
        id: CryptoService.id(), username, email: `${username}@relay.local`, name: 'Initial Administrator', role: 'owner', status: 'active',
        passwordHash: await hashPassword(password), mustChangePassword: true, mfaEnabled: false, failedLogins: 0, createdAt: new Date(), updatedAt: new Date(),
      });
    } catch {
      return; // another worker/instance created the initial admin concurrently
    }
    await this.seedDefaults();
    await this.audit.log(SYSTEM_ACTOR, { action: 'system.initialized', details: { initialAdmin: username, database: this.store.kind } });
    const line = '='.repeat(72);
    // Printed once, directly to stdout so it is not swallowed by log level filters.
    console.log(
      `\n${line}\n  RELAY - NEW DATABASE INITIALISED\n\n  Initial owner account (shown ONCE - store it securely):\n    Username: ${username}\n    Password: ${password}\n\n  You must change the password at first sign-in. Update the email address\n  under Users and enable MFA under Profile.\n${line}\n`,
    );
  }

  private async seedDefaults() {
    const now = new Date();
    await this.store.insert(C.guardrails, {
      id: CryptoService.id(), name: 'Baseline protection', description: 'Masks secrets/API keys and flags prompt-injection attempts. Applies to every app.',
      status: 'active', isDefault: true, config: { pii: { mode: 'redact', entities: ['secret'] }, promptInjection: 'flag' }, createdAt: now, updatedAt: now,
    });
    await this.store.insert(C.guardrails, {
      id: CryptoService.id(), name: 'Strict PII (reversible)', description: 'Masks personal data before it reaches the model and restores it in the response.',
      status: 'active', isDefault: false, config: { pii: { mode: 'mask_restore', entities: ['email', 'phone', 'credit_card', 'ssn', 'iban', 'ip_address', 'secret'] }, promptInjection: 'block' },
      createdAt: now, updatedAt: now,
    });
  }
}
