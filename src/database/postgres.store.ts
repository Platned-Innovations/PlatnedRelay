import { Pool, types } from 'pg';
import { AggregateSpec, CollectionDef, FieldType, Filter, FindOptions, isOps, MetricOp, Row, Store } from './store';
import { CryptoService } from '../common/crypto.service';

// int8 -> number (token counts comfortably fit in a double)
types.setTypeParser(20, (v) => parseInt(v, 10));
// numeric -> number
types.setTypeParser(1700, (v) => parseFloat(v));

const PG_TYPES: Record<FieldType, string> = {
  string: 'text',
  text: 'text',
  int: 'bigint',
  number: 'double precision',
  bool: 'boolean',
  date: 'timestamptz',
  json: 'jsonb',
};

const q = (ident: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) throw new Error(`Invalid identifier: ${ident}`);
  return `"${ident}"`;
};

class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export class PostgresStore extends Store {
  readonly kind = 'postgres' as const;
  private pool: Pool;
  private defs = new Map<string, CollectionDef>();

  constructor(url: string) {
    super();
    const ssl = /sslmode=(require|verify)/.test(url) || /\.postgres\.database\.azure\.com/.test(url);
    this.pool = new Pool({
      connectionString: url,
      max: 20,
      idleTimeoutMillis: 30_000,
      ssl: ssl ? { rejectUnauthorized: !/sslmode=require/.test(url) || /sslrootcert/.test(url) } : undefined,
    });
    this.pool.on('connect', (client) => {
      client.query(`SET TIME ZONE 'UTC'`).catch(() => undefined);
    });
  }

  async init(defs: CollectionDef[]): Promise<void> {
    for (const def of defs) {
      this.defs.set(def.name, def);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${q(def.name)} ("id" text PRIMARY KEY)`);
      for (const [field, type] of Object.entries(def.fields)) {
        await this.pool.query(`ALTER TABLE ${q(def.name)} ADD COLUMN IF NOT EXISTS ${q(field)} ${PG_TYPES[type]}`);
      }
      for (const cols of def.indexes ?? []) {
        const name = `ix_${def.name}_${cols.join('_')}`.slice(0, 60);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS ${q(name)} ON ${q(def.name)} (${cols.map(q).join(', ')})`);
      }
      for (const cols of def.unique ?? []) {
        const name = `ux_${def.name}_${cols.join('_')}`.slice(0, 60);
        await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(name)} ON ${q(def.name)} (${cols.map(q).join(', ')})`);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private def(collection: string): CollectionDef {
    const d = this.defs.get(collection);
    if (!d) throw new Error(`Unknown collection ${collection}`);
    return d;
  }

  private fieldType(def: CollectionDef, field: string): FieldType {
    if (field === 'id') return 'string';
    const t = def.fields[field];
    if (!t) throw new Error(`Unknown field ${def.name}.${field}`);
    return t;
  }

  private toDb(type: FieldType, v: unknown): unknown {
    if (v === undefined || v === null) return null;
    if (type === 'json') return JSON.stringify(v);
    if (type === 'date') return v instanceof Date ? v : new Date(v as string);
    return v;
  }

  private fromDb(row: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
    return out;
  }

  private where(def: CollectionDef, filter: Filter | undefined, p: Params): string {
    if (!filter) return 'TRUE';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      if (key === '$or' || key === '$and') {
        const subs = (value as Filter[]).map((f) => `(${this.where(def, f, p)})`);
        if (subs.length) parts.push(`(${subs.join(key === '$or' ? ' OR ' : ' AND ')})`);
        else if (key === '$or') parts.push('FALSE');
        continue;
      }
      const type = this.fieldType(def, key);
      const col = q(key);
      if (isOps(value)) {
        for (const [op, arg] of Object.entries(value)) {
          switch (op) {
            case '$in': {
              const arr = arg as unknown[];
              parts.push(arr.length ? `${col} IN (${arr.map((a) => p.add(this.toDb(type, a))).join(', ')})` : 'FALSE');
              break;
            }
            case '$nin': {
              const arr = arg as unknown[];
              if (arr.length) parts.push(`(${col} IS NULL OR ${col} NOT IN (${arr.map((a) => p.add(this.toDb(type, a))).join(', ')}))`);
              break;
            }
            case '$ne':
              parts.push(arg === null ? `${col} IS NOT NULL` : `${col} IS DISTINCT FROM ${p.add(this.toDb(type, arg))}`);
              break;
            case '$gt': parts.push(`${col} > ${p.add(this.toDb(type, arg))}`); break;
            case '$gte': parts.push(`${col} >= ${p.add(this.toDb(type, arg))}`); break;
            case '$lt': parts.push(`${col} < ${p.add(this.toDb(type, arg))}`); break;
            case '$lte': parts.push(`${col} <= ${p.add(this.toDb(type, arg))}`); break;
            case '$exists': parts.push(arg ? `${col} IS NOT NULL` : `${col} IS NULL`); break;
            case '$ilike': {
              const esc = String(arg).replace(/[\\%_]/g, (m) => `\\${m}`);
              parts.push(`${col}::text ILIKE ${p.add(`%${esc}%`)}`);
              break;
            }
            default:
              throw new Error(`Unsupported operator ${op}`);
          }
        }
      } else if (value === null) {
        parts.push(`${col} IS NULL`);
      } else {
        parts.push(`${col} = ${p.add(this.toDb(type, value))}`);
      }
    }
    return parts.length ? parts.join(' AND ') : 'TRUE';
  }

  private orderBy(def: CollectionDef, sort?: Record<string, 1 | -1>): string {
    if (!sort || !Object.keys(sort).length) return '';
    return (
      ' ORDER BY ' +
      Object.entries(sort)
        .map(([f, d]) => {
          this.fieldType(def, f);
          return `${q(f)} ${d === -1 ? 'DESC' : 'ASC'} NULLS LAST`;
        })
        .join(', ')
    );
  }

  async insert<T extends { id: string }>(collection: string, doc: T): Promise<T> {
    const def = this.def(collection);
    const p = new Params();
    const cols: string[] = [];
    const vals: string[] = [];
    for (const [k, v] of Object.entries(doc)) {
      if (v === undefined) continue;
      const type = this.fieldType(def, k);
      cols.push(q(k));
      vals.push(p.add(this.toDb(type, v)));
    }
    const res = await this.pool.query(`INSERT INTO ${q(collection)} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`, p.values);
    return this.fromDb(res.rows[0]) as T;
  }

  async findById<T = Row>(collection: string, id: string): Promise<T | null> {
    this.def(collection);
    const res = await this.pool.query(`SELECT * FROM ${q(collection)} WHERE "id" = $1`, [id]);
    return res.rows[0] ? (this.fromDb(res.rows[0]) as T) : null;
  }

  async findOne<T = Row>(collection: string, filter: Filter, opts?: FindOptions): Promise<T | null> {
    const rows = await this.find<T>(collection, filter, { ...opts, limit: 1 });
    return rows[0] ?? null;
  }

  async find<T = Row>(collection: string, filter?: Filter, opts?: FindOptions): Promise<T[]> {
    const def = this.def(collection);
    const p = new Params();
    let sql = `SELECT * FROM ${q(collection)} WHERE ${this.where(def, filter, p)}${this.orderBy(def, opts?.sort)}`;
    if (opts?.limit) sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    if (opts?.skip) sql += ` OFFSET ${Math.max(0, Math.floor(opts.skip))}`;
    const res = await this.pool.query(sql, p.values);
    return res.rows.map((r) => this.fromDb(r) as T);
  }

  async count(collection: string, filter?: Filter): Promise<number> {
    const def = this.def(collection);
    const p = new Params();
    const res = await this.pool.query(`SELECT COUNT(*)::int AS c FROM ${q(collection)} WHERE ${this.where(def, filter, p)}`, p.values);
    return res.rows[0].c;
  }

  private setClause(def: CollectionDef, patch: Record<string, unknown>, p: Params): string {
    const sets: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      const type = this.fieldType(def, k);
      sets.push(`${q(k)} = ${p.add(this.toDb(type, v))}`);
    }
    return sets.join(', ');
  }

  async update<T = Row>(collection: string, id: string, patch: Record<string, unknown>): Promise<T | null> {
    return this.updateWhere<T>(collection, id, {}, patch);
  }

  async updateWhere<T = Row>(collection: string, id: string, filter: Filter, patch: Record<string, unknown>): Promise<T | null> {
    const def = this.def(collection);
    const p = new Params();
    const set = this.setClause(def, patch, p);
    if (!set) return this.findOne<T>(collection, { ...filter, id });
    const idParam = p.add(id);
    const res = await this.pool.query(
      `UPDATE ${q(collection)} SET ${set} WHERE "id" = ${idParam} AND ${this.where(def, filter, p)} RETURNING *`,
      p.values,
    );
    return res.rows[0] ? (this.fromDb(res.rows[0]) as T) : null;
  }

  async updateMany(collection: string, filter: Filter, patch: Record<string, unknown>): Promise<number> {
    const def = this.def(collection);
    const p = new Params();
    const set = this.setClause(def, patch, p);
    if (!set) return 0;
    const res = await this.pool.query(`UPDATE ${q(collection)} SET ${set} WHERE ${this.where(def, filter, p)}`, p.values);
    return res.rowCount ?? 0;
  }

  async deleteById(collection: string, id: string): Promise<boolean> {
    this.def(collection);
    const res = await this.pool.query(`DELETE FROM ${q(collection)} WHERE "id" = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteMany(collection: string, filter: Filter): Promise<number> {
    const def = this.def(collection);
    const p = new Params();
    const res = await this.pool.query(`DELETE FROM ${q(collection)} WHERE ${this.where(def, filter, p)}`, p.values);
    return res.rowCount ?? 0;
  }

  async incrementUnique<T = Row>(
    collection: string,
    key: Record<string, unknown>,
    inc: Record<string, number>,
    setOnInsert: Record<string, unknown> = {},
    set: Record<string, unknown> = {},
  ): Promise<T> {
    const def = this.def(collection);
    const p = new Params();
    const insertDoc: Record<string, unknown> = { id: CryptoService.id(), ...setOnInsert, ...set, ...key, ...inc };
    const cols = Object.keys(insertDoc);
    const vals = cols.map((c) => p.add(this.toDb(this.fieldType(def, c), insertDoc[c])));
    const updates = [
      ...Object.keys(inc).map((f) => `${q(f)} = COALESCE(${q(collection)}.${q(f)}, 0) + EXCLUDED.${q(f)}`),
      ...Object.keys(set).map((f) => `${q(f)} = EXCLUDED.${q(f)}`),
    ];
    const res = await this.pool.query(
      `INSERT INTO ${q(collection)} (${cols.map(q).join(', ')}) VALUES (${vals.join(', ')})
       ON CONFLICT (${Object.keys(key).map(q).join(', ')}) DO UPDATE SET ${updates.join(', ')} RETURNING *`,
      p.values,
    );
    return this.fromDb(res.rows[0]) as T;
  }

  private metricSql(def: CollectionDef, m: MetricOp, p: Params): string {
    switch (m.op) {
      case 'count':
        return 'COUNT(*)::float8';
      case 'countWhere':
        this.fieldType(def, m.field);
        return `COUNT(*) FILTER (WHERE ${q(m.field)} = ${p.add(m.equals)})::float8`;
      default:
        this.fieldType(def, m.field);
        return `COALESCE(${m.op.toUpperCase()}(${q(m.field)}), 0)::float8`;
    }
  }

  async aggregate(collection: string, spec: AggregateSpec): Promise<Row[]> {
    const def = this.def(collection);
    const p = new Params();
    const selects: string[] = [];
    const groups: string[] = [];
    for (const g of spec.groupBy ?? []) {
      this.fieldType(def, g);
      selects.push(`${q(g)} AS ${q(g)}`);
      groups.push(q(g));
    }
    if (spec.bucket) {
      this.fieldType(def, spec.bucket.field);
      const unit = { hour: 'hour', day: 'day', week: 'week', month: 'month' }[spec.bucket.unit];
      selects.push(`date_trunc('${unit}', ${q(spec.bucket.field)}) AS "bucket"`);
      groups.push(`date_trunc('${unit}', ${q(spec.bucket.field)})`);
    }
    for (const [name, m] of Object.entries(spec.metrics)) selects.push(`${this.metricSql(def, m, p)} AS ${q(name)}`);
    const where = this.where(def, spec.filter, p);
    let sql = `SELECT ${selects.join(', ')} FROM ${q(collection)} WHERE ${where}`;
    if (groups.length) sql += ` GROUP BY ${groups.join(', ')}`;
    if (spec.sort?.length) {
      const allowed = new Set([...(spec.groupBy ?? []), ...Object.keys(spec.metrics), 'bucket']);
      const order = spec.sort.filter((s) => allowed.has(s.key)).map((s) => `${q(s.key)} ${s.dir === -1 ? 'DESC' : 'ASC'}`);
      if (order.length) sql += ' ORDER BY ' + order.join(', ');
    }
    if (spec.limit) sql += ` LIMIT ${Math.floor(spec.limit)}`;
    const res = await this.pool.query(sql, p.values);
    return res.rows.map((r) => {
      if (r.bucket instanceof Date) r.bucket = r.bucket.toISOString();
      return r;
    });
  }
}
