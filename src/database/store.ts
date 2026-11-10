/**
 * Database-agnostic persistence contract. Relay supports PostgreSQL and MongoDB
 * through two adapters implementing this interface; all domain services use it
 * exclusively so features work identically on both engines.
 */
export type FieldType = 'string' | 'text' | 'int' | 'number' | 'bool' | 'date' | 'json';

export interface CollectionDef {
  name: string;
  fields: Record<string, FieldType>;
  indexes?: string[][];
  unique?: string[][];
}

/** Operators supported in filters. Values are compared with equality when not an operator object. */
export interface FieldOps {
  $in?: unknown[];
  $nin?: unknown[];
  $ne?: unknown;
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $exists?: boolean;
  /** Case-insensitive substring match. */
  $ilike?: string;
}

export type Filter = { [field: string]: unknown } & { $or?: Filter[]; $and?: Filter[] };

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export type MetricOp =
  | { op: 'sum' | 'avg' | 'max' | 'min'; field: string }
  | { op: 'count' }
  | { op: 'countWhere'; field: string; equals: string | number | boolean };

export interface AggregateSpec {
  filter?: Filter;
  groupBy?: string[];
  bucket?: { field: string; unit: 'hour' | 'day' | 'week' | 'month' };
  metrics: Record<string, MetricOp>;
  sort?: { key: string; dir: 1 | -1 }[];
  limit?: number;
}

export type Row = Record<string, any>;

export abstract class Store {
  abstract readonly kind: 'postgres' | 'mongodb';
  abstract init(defs: CollectionDef[]): Promise<void>;
  abstract close(): Promise<void>;
  abstract ping(): Promise<boolean>;

  abstract insert<T extends { id: string }>(collection: string, doc: T): Promise<T>;
  /** Bulk insert (used by write-behind buffers on the gateway hot path). */
  abstract insertMany<T extends { id: string }>(collection: string, docs: T[]): Promise<void>;
  abstract findById<T = Row>(collection: string, id: string): Promise<T | null>;
  abstract findOne<T = Row>(collection: string, filter: Filter, opts?: FindOptions): Promise<T | null>;
  abstract find<T = Row>(collection: string, filter?: Filter, opts?: FindOptions): Promise<T[]>;
  abstract count(collection: string, filter?: Filter): Promise<number>;
  /** Partial update; `null`/`undefined` values clear the field. Returns the updated document. */
  abstract update<T = Row>(collection: string, id: string, patch: Record<string, unknown>): Promise<T | null>;
  /** Conditional update: only applies when the document also matches `filter`. */
  abstract updateWhere<T = Row>(collection: string, id: string, filter: Filter, patch: Record<string, unknown>): Promise<T | null>;
  abstract updateMany(collection: string, filter: Filter, patch: Record<string, unknown>): Promise<number>;
  abstract deleteById(collection: string, id: string): Promise<boolean>;
  abstract deleteMany(collection: string, filter: Filter): Promise<number>;
  /**
   * Atomic upsert + increment keyed by a unique index (`key` fields must form a unique index).
   * `set` fields are written on every call, `setOnInsert` only when the row is created.
   */
  abstract incrementUnique<T = Row>(
    collection: string,
    key: Record<string, unknown>,
    inc: Record<string, number>,
    setOnInsert?: Record<string, unknown>,
    set?: Record<string, unknown>,
  ): Promise<T>;
  abstract aggregate(collection: string, spec: AggregateSpec): Promise<Row[]>;
}

export function isOps(v: unknown): v is FieldOps {
  return !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v as object).some((k) => k.startsWith('$'));
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
