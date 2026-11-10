/**
 * Break-glass administration CLI. Runs directly against the database using the
 * same environment as the server (DB_TYPE, DATABASE_URL, RELAY_MASTER_KEY, .env).
 *
 *   npm run admin -- list                 list admin accounts
 *   npm run admin -- reset [username]     new one-time password for a user (default: first active owner)
 *
 * Only someone with server/database access can run this; every reset is audited.
 */
import 'reflect-metadata';
import { loadEnv } from './config/env';
import { Store } from './database/store';
import { SCHEMA, C } from './database/schema';
import { PostgresStore } from './database/postgres.store';
import { MongoStore } from './database/mongo.store';
import { CryptoService } from './common/crypto.service';
import { AuditService } from './audit/audit.service';
import { hashPassword } from './auth/security';

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const env = loadEnv();
  const store: Store = env.dbType === 'mongodb' ? new MongoStore(env.databaseUrl) : new PostgresStore(env.databaseUrl);
  await store.init(SCHEMA);
  try {
    if (cmd === 'list') {
      const users = await store.find<any>(C.users, {}, { sort: { createdAt: 1 } });
      if (!users.length) console.log('No admin accounts yet. Start the server once to create the initial owner.');
      for (const u of users) console.log(`${u.username.padEnd(24)} ${u.role.padEnd(7)} ${u.status.padEnd(9)} ${u.email}`);
      return;
    }
    if (cmd === 'reset') {
      const user = arg
        ? await store.findOne<any>(C.users, { username: arg.toLowerCase() })
        : await store.findOne<any>(C.users, { role: 'owner', status: 'active' }, { sort: { createdAt: 1 } });
      if (!user) throw new Error(arg ? `No user "${arg}"` : 'No active owner found');
      const password = CryptoService.generatePassword(20);
      await store.update(C.users, user.id, {
        passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null,
        status: user.status === 'invited' ? 'active' : user.status, inviteTokenHash: null, inviteExpiresAt: null, updatedAt: new Date(),
      });
      await store.updateMany(C.sessions, { userId: user.id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
      await new AuditService(store, new CryptoService()).log(
        { type: 'system', id: 'cli', name: 'admin-cli' },
        { action: 'user.password_reset_cli', resourceType: 'user', resourceId: user.id, details: { username: user.username } },
      );
      console.log(`\nPassword reset for "${user.username}" (${user.role}). Shown once - change it at first sign-in.\n  Username: ${user.username}\n  Password: ${password}\n`);
      if (user.status === 'disabled') console.log('Note: this account is disabled; enable it from another owner account.');
      return;
    }
    console.log('Usage:\n  npm run admin -- list\n  npm run admin -- reset [username]');
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
