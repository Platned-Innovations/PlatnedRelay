/**
 * Minimal environment configuration. Only things that MUST exist before the
 * database is reachable live here; everything else is stored in the DB and
 * managed from the admin UI.
 */
export type DbType = 'postgres' | 'mongodb';

export interface RelayEnv {
  dbType: DbType;
  databaseUrl: string;
  masterKey: Buffer;
  previousMasterKey?: Buffer;
  port: number;
  trustProxy?: string;
  nodeEnv: string;
}

function decodeKey(name: string, value: string | undefined, required: boolean): Buffer | undefined {
  if (!value) {
    if (required) {
      throw new Error(
        `${name} is required. Generate one with "npm run gen:key" and keep it in a secret store (Azure Key Vault, Docker secret...).`,
      );
    }
    return undefined;
  }
  const buf = Buffer.from(value.trim(), 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes encoded as base64 (got ${buf.length} bytes).`);
  return buf;
}

let cached: RelayEnv | undefined;

export function loadEnv(): RelayEnv {
  if (cached) return cached;
  const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase();
  if (dbType !== 'postgres' && dbType !== 'mongodb') throw new Error('DB_TYPE must be "postgres" or "mongodb"');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  cached = {
    dbType,
    databaseUrl,
    masterKey: decodeKey('RELAY_MASTER_KEY', process.env.RELAY_MASTER_KEY, true)!,
    previousMasterKey: decodeKey('RELAY_MASTER_KEY_PREVIOUS', process.env.RELAY_MASTER_KEY_PREVIOUS, false),
    port: Number(process.env.PORT || process.env.WEBSITES_PORT || 8080),
    trustProxy: process.env.TRUST_PROXY,
    nodeEnv: process.env.NODE_ENV || 'production',
  };
  return cached;
}
