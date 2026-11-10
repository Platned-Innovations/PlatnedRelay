import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Empty } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  /** Value used for sorting; defaults to row[key]. Set `sortable: false` to disable. */
  sortValue?: (row: T) => string | number | boolean | null | undefined;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  numeric?: boolean;
  width?: number | string;
  className?: string;
  /** Footer cell content (totals row). */
  footer?: ReactNode;
  hideSm?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyTitle = 'No records',
  emptyText,
  initialSort,
  compact,
  selectedKey,
  showFooter,
  highlightKeys,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyText?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  compact?: boolean;
  selectedKey?: string | null;
  showFooter?: boolean;
  /** Rows to flash briefly (e.g. new rows in live mode). */
  highlightKeys?: Set<string>;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue ?? ((r: T) => (r as Record<string, unknown>)[col.key] as string | number | null | undefined);
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === vb) return 0;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * mul;
    });
  }, [rows, sort, columns]);

  const toggle = (key: string) => {
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));
  };

  const cellClass = (c: Column<T>) =>
    [c.numeric || c.align === 'right' ? 'num' : '', c.align === 'center' ? 'center' : '', c.className ?? '', c.hideSm ? 'hide-sm' : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="table-wrap">
      <table className={`table${compact ? ' table-compact' : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = c.sortable !== false && c.header !== '';
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={[cellClass(c), sortable ? 'sortable' : ''].filter(Boolean).join(' ') || undefined}
                  style={c.width ? { width: c.width } : undefined}
                  onClick={sortable ? () => toggle(c.key) : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.header}
                  {sortable && (
                    <span className="sort-ind" style={{ opacity: active ? 1 : 0.35 }}>
                      {active ? sort!.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ChevronsUpDown size={12} />}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 0 }}>
                <Empty title={emptyTitle}>{emptyText}</Empty>
              </td>
            </tr>
          ) : (
            sorted.map((r) => {
              const k = rowKey(r);
              return (
                <tr
                  key={k}
                  className={[onRowClick ? 'clickable' : '', selectedKey === k ? 'selected' : '', highlightKeys?.has(k) ? 'row-new' : ''].filter(Boolean).join(' ') || undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cellClass(c)}>
                      {c.render ? c.render(r) : ((r as Record<string, unknown>)[c.key] as ReactNode) ?? <span className="muted">-</span>}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
        {showFooter && sorted.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <td key={c.key} className={cellClass(c)}>
                  {c.footer}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pager">
      <span>
        {from.toLocaleString()}-{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="row">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(1)}>
          First
        </button>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} / {pages}
        </span>
        <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
