import { Db, Document, MongoClient, MongoServerError } from 'mongodb';
import { AggregateSpec, CollectionDef, escapeRegex, Filter, FindOptions, isOps, MetricOp, Row, Store } from './store';
import { CryptoService } from '../common/crypto.service';

export class MongoStore extends Store {
  readonly kind = 'mongodb' as const;
  private client: MongoClient;
  private db!: Db;
  private defs = new Map<string, CollectionDef>();

  constructor(private readonly url: string) {
    super();
    this.client = new MongoClient(url, { maxPoolSize: 20 });
  }

  async init(defs: CollectionDef[]): Promise<void> {
    await this.client.connect();
    this.db = this.client.db();
    for (const def of defs) {
      this.defs.set(def.name, def);
      const coll = this.db.collection(def.name);
      for (const cols of def.indexes ?? []) {
        await coll.createIndex(Object.fromEntries(cols.map((c) => [c, 1])), { name: `ix_${cols.join('_')}` });
      }
      for (const cols of def.unique ?? []) {
        // sparse: documents missing the field are not indexed (nulls are never stored, see clean()).
        await coll.createIndex(Object.fromEntries(cols.map((c) => [c, 1])), { name: `ux_${cols.join('_')}`, unique: true, sparse: true });
      }
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  private coll(name: string) {
    if (!this.defs.has(name)) throw new Error(`Unknown collection ${name}`);
    return this.db.collection(name);
  }

  private checkField(collection: string, field: string) {
    if (field === 'id') return;
    if (!this.defs.get(collection)!.fields[field]) throw new Error(`Unknown field ${collection}.${field}`);
  }

  private key(field: string): string {
    return field === 'id' ? '_id' : field;
  }

  private out(doc: Document | null): Row | null {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    const res: Row = { id: _id };
    for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) res[k] = v;
    return res;
  }

  private toMongo(collection: string, filter: Filter | undefined): Document {
    if (!filter) return {};
    const out: Document = {};
    const and: Document[] = [];
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      if (k === '$or' || k === '$and') {
        const subs = (v as Filter[]).map((f) => this.toMongo(collection, f));
        if (k === '$or') and.push(subs.length ? { $or: subs } : { _id: { $in: [] } });
        else if (subs.length) and.push({ $and: subs });
        continue;
      }
      this.checkField(collection, k);
      const field = this.key(k);
      if (isOps(v)) {
        const ops: Document = {};
        for (const [op, arg] of Object.entries(v)) {
          if (op === '$ilike') {
            ops.$regex = escapeRegex(String(arg));
            ops.$options = 'i';
          } else if (['$in', '$nin', '$ne', '$gt', '$gte', '$lt', '$lte', '$exists'].includes(op)) {
            ops[op] = arg;
          } else throw new Error(`Unsupported operator ${op}`);
        }
        if (ops.$exists === true) ops.$ne = ops.$ne ?? null;
        if (ops.$exists === false) {
          delete ops.$exists;
          ops.$eq = null;
        }
        out[field] = ops;
      } else {
        out[field] = v;
      }
    }
    if (and.length) out.$and = and;
    return out;
  }

  /** Never persist null/undefined: keeps sparse unique indexes behaving like SQL unique constraints. */
  private clean(doc: Record<string, unknown>): Document {
    const out: Document = {};
    for (const [k, v] of Object.entries(doc)) if (v !== null && v !== undefined) out[this.key(k)] = v;
    return out;
  }

  async insert<T extends { id: string }>(collection: string, doc: T): Promise<T> {
    for (const k of Object.keys(doc)) this.checkField(collection, k);
    await this.coll(collection).insertOne(this.clean(doc as Record<string, unknown>));
    return this.out(this.clean(doc as Record<string, unknown>)) as T;
  }

  async findById<T = Row>(collection: string, id: string): Promise<T | null> {
    return this.out(await this.coll(collection).findOne({ _id: id as any })) as T | null;
  }

  async findOne<T = Row>(collection: string, filter: Filter, opts?: FindOptions): Promise<T | null> {
    const rows = await this.find<T>(collection, filter, { ...opts, limit: 1 });
    return rows[0] ?? null;
  }

  private sort(collection: string, sort?: Record<string, 1 | -1>): Document | undefined {
    if (!sort) return undefined;
    const s: Document = {};
    for (const [k, d] of Object.entries(sort)) {
      this.checkField(collection, k);
      s[this.key(k)] = d;
    }
    return s;
  }

  async find<T = Row>(collection: string, filter?: Filter, opts?: FindOptions): Promise<T[]> {
    let cursor = this.coll(collection).find(this.toMongo(collection, filter));
    const sort = this.sort(collection, opts?.sort);
    if (sort) cursor = cursor.sort(sort);
    if (opts?.skip) cursor = cursor.skip(opts.skip);
    if (opts?.limit) cursor = cursor.limit(opts.limit);
    const docs = await cursor.toArray();
    return docs.map((d) => this.out(d) as T);
  }

  async count(collection: string, filter?: Filter): Promise<number> {
    return this.coll(collection).countDocuments(this.toMongo(collection, filter));
  }

  private updateDoc(collection: string, patch: Record<string, unknown>): Document {
    const $set: Document = {};
    const $unset: Document = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      this.checkField(collection, k);
      if (v === null || v === undefined) $unset[k] = '';
      else $set[k] = v;
    }
    const upd: Document = {};
    if (Object.keys($set).length) upd.$set = $set;
    if (Object.keys($unset).length) upd.$unset = $unset;
    return upd;
  }

  async update<T = Row>(collection: string, id: string, patch: Record<string, unknown>): Promise<T | null> {
    return this.updateWhere<T>(collection, id, {}, patch);
  }

  async updateWhere<T = Row>(collection: string, id: string, filter: Filter, patch: Record<string, unknown>): Promise<T | null> {
    const upd = this.updateDoc(collection, patch);
    const query = { ...this.toMongo(collection, filter), _id: id as any };
    if (!Object.keys(upd).length) return this.out(await this.coll(collection).findOne(query)) as T | null;
    const res = await this.coll(collection).findOneAndUpdate(query, upd, { returnDocument: 'after' });
    return this.out(res) as T | null;
  }

  async updateMany(collection: string, filter: Filter, patch: Record<string, unknown>): Promise<number> {
    const upd = this.updateDoc(collection, patch);
    if (!Object.keys(upd).length) return 0;
    const res = await this.coll(collection).updateMany(this.toMongo(collection, filter), upd);
    return res.modifiedCount;
  }

  async deleteById(collection: string, id: string): Promise<boolean> {
    const res = await this.coll(collection).deleteOne({ _id: id as any });
    return res.deletedCount > 0;
  }

  async deleteMany(collection: string, filter: Filter): Promise<number> {
    const res = await this.coll(collection).deleteMany(this.toMongo(collection, filter));
    return res.deletedCount;
  }

  async incrementUnique<T = Row>(
    collection: string,
    key: Record<string, unknown>,
    inc: Record<string, number>,
    setOnInsert: Record<string, unknown> = {},
    set: Record<string, unknown> = {},
  ): Promise<T> {
    for (const k of [...Object.keys(key), ...Object.keys(inc), ...Object.keys(setOnInsert), ...Object.keys(set)]) this.checkField(collection, k);
    const update: Document = { $inc: inc, $setOnInsert: { _id: CryptoService.id(), ...this.clean(setOnInsert) } };
    if (Object.keys(set).length) update.$set = this.clean(set);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.coll(collection).findOneAndUpdate(key, update, { upsert: true, returnDocument: 'after' });
        return this.out(res) as T;
      } catch (e) {
        // Concurrent upserts can race on the unique index; the retry hits the existing document.
        if (e instanceof MongoServerError && e.code === 11000 && attempt < 3) continue;
        throw e;
      }
    }
  }

  private metric(m: MetricOp): Document {
    switch (m.op) {
      case 'count':
        return { $sum: 1 };
      case 'countWhere':
        return { $sum: { $cond: [{ $eq: [`$${m.field}`, m.equals] }, 1, 0] } };
      default:
        return { [`$${m.op}`]: `$${m.field}` };
    }
  }

  async aggregate(collection: string, spec: AggregateSpec): Promise<Row[]> {
    const groupId: Document = {};
    for (const g of spec.groupBy ?? []) {
      this.checkField(collection, g);
      groupId[g] = `$${this.key(g)}`;
    }
    if (spec.bucket) {
      this.checkField(collection, spec.bucket.field);
      groupId.bucket = { $dateTrunc: { date: `$${spec.bucket.field}`, unit: spec.bucket.unit, startOfWeek: 'monday', timezone: 'UTC' } };
    }
    const group: Document = { _id: groupId };
    for (const [name, m] of Object.entries(spec.metrics)) {
      if ('field' in m) this.checkField(collection, m.field);
      group[name] = this.metric(m);
    }
    const project: Document = { _id: 0 };
    for (const k of Object.keys(groupId)) project[k] = `$_id.${k}`;
    for (const name of Object.keys(spec.metrics)) project[name] = { $ifNull: [`$${name}`, 0] };
    const pipeline: Document[] = [{ $match: this.toMongo(collection, spec.filter) }, { $group: group }, { $project: project }];
    if (spec.sort?.length) pipeline.push({ $sort: Object.fromEntries(spec.sort.map((s) => [s.key, s.dir])) });
    if (spec.limit) pipeline.push({ $limit: spec.limit });
    const rows = await this.coll(collection).aggregate(pipeline).toArray();
    return rows.map((r) => {
      if (r.bucket instanceof Date) r.bucket = r.bucket.toISOString();
      return r;
    });
  }
}
