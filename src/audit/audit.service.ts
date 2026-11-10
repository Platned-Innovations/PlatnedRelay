import { Injectable, Logger } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, canonicalJson, redactSecrets } from '../common/util';

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'success' | 'failure' | 'denied';
  details?: Record<string, unknown>;
}

const GENESIS = '0'.repeat(64);

/**
 * Append-only, tamper-evident audit trail.
 *
 * Every entry carries a monotonically increasing `seq` (unique index), the hash
 * of the previous entry and an HMAC over its own canonical content keyed from
 * the master key. Editing, deleting or re-ordering any entry breaks the chain,
 * which `verify()` detects. Attackers with DB write access but without the
 * master key cannot forge valid hashes.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store, private readonly crypto: CryptoService) {}

  log(actor: Actor, entry: AuditEntry): Promise<void> {
    const run = this.queue.then(() => this.append(actor, entry)).catch((e) => this.logger.error(`Audit write failed: ${e.message}`));
    this.queue = run;
    return run as Promise<void>;
  }

  private content(e: Record<string, unknown>) {
    return canonicalJson({
      seq: e.seq, ts: e.ts, actorType: e.actorType, actorId: e.actorId, actorName: e.actorName, action: e.action,
      resourceType: e.resourceType, resourceId: e.resourceId, outcome: e.outcome, ip: e.ip, userAgent: e.userAgent,
      details: e.details, prevHash: e.prevHash,
    });
  }

  private async append(actor: Actor, entry: AuditEntry) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.store.findOne<any>(C.audit, {}, { sort: { seq: -1 } });
      const doc: Record<string, unknown> = {
        id: CryptoService.id(),
        seq: (last?.seq ?? 0) + 1,
        ts: new Date(),
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        outcome: entry.outcome ?? 'success',
        ip: actor.ip,
        userAgent: actor.userAgent?.slice(0, 300),
        // JSON round-trip: drops undefined values and turns Dates into strings so the
        // stored document is byte-for-byte what was hashed on every database engine.
        details: entry.details ? JSON.parse(JSON.stringify(redactSecrets(entry.details))) : undefined,
        prevHash: last?.hash ?? GENESIS,
        kid: this.crypto.keyId,
      };
      doc.hash = this.crypto.auditMac(this.content(doc));
      try {
        await this.store.insert(C.audit, doc as any);
        return;
      } catch (e: any) {
        // Another instance appended concurrently (unique seq) - re-read the tail and retry.
        if (attempt === 4) throw e;
      }
    }
  }

  async verify(): Promise<{ ok: boolean; checked: number; brokenAt?: number; reason?: string }> {
    let prev = GENESIS;
    let expectedSeq = 1;
    let checked = 0;
    const page = 1000;
    for (;;) {
      const rows = await this.store.find<any>(C.audit, { seq: { $gte: expectedSeq } }, { sort: { seq: 1 }, limit: page });
      if (!rows.length) break;
      for (const r of rows) {
        if (r.seq !== expectedSeq) {
          // Entries older than the retention window may be purged; the first remaining entry restarts the chain.
          if (checked === 0) prev = r.prevHash;
          else return { ok: false, checked, brokenAt: expectedSeq, reason: 'Missing entry (gap in sequence)' };
        }
        if (r.prevHash !== prev) return { ok: false, checked, brokenAt: r.seq, reason: 'Previous-hash mismatch' };
        const mac = this.crypto.auditMacWith(r.kid, this.content(r));
        if (!mac) return { ok: false, checked, brokenAt: r.seq, reason: 'Signed with unknown master key' };
        if (!CryptoService.safeEqual(mac, r.hash)) return { ok: false, checked, brokenAt: r.seq, reason: 'Content hash mismatch (entry modified)' };
        prev = r.hash;
        expectedSeq = r.seq + 1;
        checked++;
      }
      if (rows.length < page) break;
    }
    return { ok: true, checked };
  }
}
