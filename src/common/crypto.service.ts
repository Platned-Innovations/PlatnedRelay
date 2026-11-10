import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { loadEnv } from '../config/env';

const VERSION = 'v1';

interface KeyRing {
  kid: string;
  enc: Buffer;
  hmac: Buffer;
  audit: Buffer;
}

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('relay-llm-gateway'), Buffer.from(info), 32));
}

function ring(master: Buffer): KeyRing {
  return {
    kid: crypto.createHash('sha256').update(master).digest('hex').slice(0, 8),
    enc: derive(master, 'enc-v1'),
    hmac: derive(master, 'hmac-v1'),
    audit: derive(master, 'audit-v1'),
  };
}

/**
 * Envelope-free authenticated encryption for secrets at rest.
 *
 * - AES-256-GCM with a random 96-bit IV per value.
 * - Additional authenticated data (AAD) binds every ciphertext to its context
 *   (e.g. "provider:<id>:apiKey") so ciphertexts cannot be swapped between records.
 * - Ciphertexts carry the key id so a master key can be rotated (old key kept
 *   as RELAY_MASTER_KEY_PREVIOUS while re-encrypting).
 * - Lookup secrets (relay API keys, session tokens) are never stored; only an
 *   HMAC-SHA256 digest keyed from the master key is.
 */
@Injectable()
export class CryptoService {
  private readonly current: KeyRing;
  private readonly previous?: KeyRing;

  constructor(master?: Buffer, previousMaster?: Buffer) {
    if (!master) {
      const env = loadEnv();
      master = env.masterKey;
      previousMaster = env.previousMasterKey;
    }
    this.current = ring(master);
    this.previous = previousMaster ? ring(previousMaster) : undefined;
  }

  get keyId(): string {
    return this.current.kid;
  }

  encrypt(plaintext: string, context: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.current.enc, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.current.kid, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string, context: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format');
    const [, kid, ivB64, tagB64, ctB64] = parts;
    const keyRing = kid === this.current.kid ? this.current : kid === this.previous?.kid ? this.previous : undefined;
    if (!keyRing) throw new Error('Ciphertext was encrypted with an unknown master key');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyRing.enc, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** True when the ciphertext was produced with an older master key and should be re-encrypted. */
  needsReEncrypt(payload: string): boolean {
    return payload.split('.')[1] !== this.current.kid;
  }

  encryptJson(value: unknown, context: string): string {
    return this.encrypt(JSON.stringify(value), context);
  }

  decryptJson<T = unknown>(payload: string, context: string): T {
    return JSON.parse(this.decrypt(payload, context)) as T;
  }

  /** Keyed digest used to look up secrets without storing them. */
  hmac(value: string): string {
    return crypto.createHmac('sha256', this.current.hmac).update(value).digest('hex');
  }

  /** Digest with the previous master key (to still accept relay keys during rotation). */
  hmacPrevious(value: string): string | undefined {
    if (!this.previous) return undefined;
    return crypto.createHmac('sha256', this.previous.hmac).update(value).digest('hex');
  }

  auditMac(value: string): string {
    return crypto.createHmac('sha256', this.current.audit).update(value).digest('hex');
  }

  auditMacWith(kid: string, value: string): string | undefined {
    const r = kid === this.current.kid ? this.current : kid === this.previous?.kid ? this.previous : undefined;
    return r ? crypto.createHmac('sha256', r.audit).update(value).digest('hex') : undefined;
  }

  static sha256(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  static randomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  }

  static id(): string {
    return crypto.randomUUID();
  }

  /** Human-friendly random password with guaranteed character classes. */
  static generatePassword(length = 20): string {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];
    const all = sets.join('');
    const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
    while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
