import { Injectable } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { canonicalJson } from '../common/util';
import { ChatRequest, ChatResponse, Usage } from './types';

interface Entry {
  response: ChatResponse;
  usage: Usage;
  modelId: string;
  providerId: string;
  expiresAt: number;
}

const MEMORY_MAX = 5_000;

/**
 * Exact-match response cache, scoped per app so responses never leak between
 * applications. Two tiers: an in-process LRU for speed and the database
 * (encrypted at rest) so all instances share hits.
 */
@Injectable()
export class ResponseCacheService {
  private mem = new Map<string, Entry>();

  constructor(private readonly store: Store, private readonly crypto: CryptoService) {}

  key(appId: string, req: ChatRequest): string {
    const { stream, stream_options, user, relay, ...rest } = req;
    return CryptoService.sha256(`${appId}|${canonicalJson(rest)}`);
  }

  async get(key: string): Promise<Entry | undefined> {
    const m = this.mem.get(key);
    if (m) {
      if (m.expiresAt > Date.now()) {
        this.mem.delete(key);
        this.mem.set(key, m);
        return m;
      }
      this.mem.delete(key);
    }
    const row = await this.store.findById<any>(C.cache, key);
    if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return undefined;
    try {
      const entry = this.crypto.decryptJson<Entry>(row.responseEnc, `cache:${key}`);
      this.remember(key, entry);
      void this.store.update(C.cache, key, { hits: (row.hits ?? 0) + 1 }).catch(() => undefined);
      return entry;
    } catch {
      return undefined;
    }
  }

  async set(key: string, appId: string, entry: Omit<Entry, 'expiresAt'>, ttlSeconds: number) {
    const full: Entry = { ...entry, expiresAt: Date.now() + ttlSeconds * 1000 };
    this.remember(key, full);
    const doc = {
      appId, model: entry.response.model, responseEnc: this.crypto.encryptJson(full, `cache:${key}`), usage: entry.usage,
      createdAt: new Date(), expiresAt: new Date(full.expiresAt), hits: 0,
    };
    try {
      const existing = await this.store.findById(C.cache, key);
      if (existing) await this.store.update(C.cache, key, doc);
      else await this.store.insert(C.cache, { id: key, ...doc });
    } catch {
      /* concurrent insert of the same key - fine */
    }
  }

  private remember(key: string, e: Entry) {
    if (this.mem.size >= MEMORY_MAX) this.mem.delete(this.mem.keys().next().value!);
    this.mem.set(key, e);
  }

  async purge(appId?: string) {
    this.mem.clear();
    return this.store.deleteMany(C.cache, appId ? { appId } : {});
  }

  async purgeExpired() {
    return this.store.deleteMany(C.cache, { expiresAt: { $lt: new Date() } });
  }
}
