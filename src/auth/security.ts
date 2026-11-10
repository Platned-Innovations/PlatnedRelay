import * as crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// ---- Password hashing (Argon2id, OWASP recommended parameters) ----
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON);
}

export async function verifyPassword(hashed: string | undefined, password: string): Promise<boolean> {
  if (!hashed) {
    // Burn comparable time to avoid user-enumeration via timing.
    await hash(password, ARGON).catch(() => undefined);
    return false;
  }
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

const COMMON = new Set(['password', 'password1', 'password123', '123456789012', 'qwertyuiop12', 'letmein12345', 'administrator', 'welcome12345', 'changeme1234']);

export function passwordPolicyErrors(password: string, minLength: number, username?: string): string[] {
  const errors: string[] = [];
  if (password.length < minLength) errors.push(`Must be at least ${minLength} characters`);
  if (password.length > 256) errors.push('Must be at most 256 characters');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) errors.push('Must contain at least 3 of: lowercase, uppercase, digit, symbol');
  if (COMMON.has(password.toLowerCase())) errors.push('Password is too common');
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) errors.push('Must not contain the username');
  return errors;
}

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

/** Returns the matched time-step (for replay protection) or null. Allows ±1 step clock drift. */
export function verifyTotp(secret: string, code: string, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(at / 30_000);
  for (const d of [0, -1, 1]) {
    const candidate = totpCode(secret, step + d);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return step + d;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Relay'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// ---- IP allowlists (IPv4 CIDR + exact IPv6) ----
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function ipAllowed(ip: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const clean = ip.replace(/^::ffff:/, '');
  for (const entry of allowlist) {
    const e = entry.trim();
    if (!e) continue;
    if (e === clean) return true;
    if (e.includes('/')) {
      const [base, bitsStr] = e.split('/');
      const bits = Number(bitsStr);
      const a = ipv4ToInt(clean);
      const b = ipv4ToInt(base);
      if (a === null || b === null || !(bits >= 0 && bits <= 32)) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((a & mask) === (b & mask)) return true;
    }
  }
  return false;
}

// ---- Simple in-memory sliding-window limiter ----
export class SlidingWindowLimiter {
  private hits = new Map<string, { t: number; w: number }[]>();
  constructor(private readonly windowMs: number) {
    setInterval(() => this.sweep(), Math.max(windowMs, 30_000)).unref();
  }
  private live(key: string) {
    const nowMs = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((h) => nowMs - h.t < this.windowMs);
    this.hits.set(key, arr);
    return arr;
  }
  /** Records a hit of `weight` and returns true when the caller is still within `limit`. */
  hit(key: string, limit: number, weight = 1): boolean {
    const arr = this.live(key);
    if (this.sum(arr) + weight > limit) return false;
    arr.push({ t: Date.now(), w: weight });
    return true;
  }
  /** Records usage without enforcing a limit (e.g. tokens known only after the response). */
  add(key: string, weight: number) {
    if (weight > 0) this.live(key).push({ t: Date.now(), w: weight });
  }
  count(key: string): number {
    return this.sum(this.live(key));
  }
  private sum(arr: { w: number }[]) {
    return arr.reduce((s, h) => s + h.w, 0);
  }
  private sweep() {
    const nowMs = Date.now();
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((h) => nowMs - h.t < this.windowMs);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}
