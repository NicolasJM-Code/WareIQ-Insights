// Pure helpers that turn catalog definitions into table columns and scoped rows.
import type { ReactNode } from 'react';
import { NOW_MS, type WhCode } from './data';
import type { Cell, CatalogCtx, Dataset, Field } from './report-catalog';
import type { Col } from '@/components/report-kit';
import { date, dateTime, dec, gbp, mins, num } from './format';

export type Row = unknown;

export function displayCell(f: Field<Row>, v: Cell): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  switch (f.kind) {
    case 'number': return typeof v === 'number' ? num(v) : String(v);
    case 'decimal': return typeof v === 'number' ? dec(v, 1) : String(v);
    case 'gbp': return typeof v === 'number' ? gbp(v) : String(v);
    case 'pct': return typeof v === 'number' ? `${dec(v, 1)}%` : String(v);
    case 'minutes': return typeof v === 'number' ? mins(v) : String(v);
    case 'date': return date(String(v).length === 10 ? `${v}T12:00:00` : String(v));
    case 'datetime': return dateTime(String(v));
    default: return String(v);
  }
}

/** Raw value for sort and CSV: numbers stay numeric, dates stay ISO (sortable), lists joined. */
export function rawCell(v: Cell): string | number | null {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}

const numeric = new Set(['number', 'decimal', 'gbp', 'pct', 'minutes']);

export function resolveFields(ds: Dataset, keys: string[]) {
  const found: Field<Row>[] = [];
  const missing: string[] = [];
  for (const k of keys) {
    const f = ds.fields.find((x) => x.key === k);
    if (f) found.push(f); else missing.push(k);
  }
  return { found, missing };
}

export function columnsFor(fields: Field<Row>[]): Col<Row>[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    align: numeric.has(f.kind) ? 'right' : undefined,
    value: (r: Row) => rawCell(f.get(r)),
    render: (r: Row): ReactNode => displayCell(f, f.get(r)),
    className: f.kind === 'list' ? 'max-w-[320px] truncate' : undefined,
  }));
}

export function searchTextFor(fields: Field<Row>[]) {
  return (r: Row) => fields.map((f) => displayCell(f, f.get(r))).join(' ');
}

export function scopedRows(ds: Dataset, ctx: CatalogCtx, warehouse: 'ALL' | WhCode, range: number, filter?: (r: Row) => boolean, sortBy?: { key: string; dir: 1 | -1 }): Row[] {
  const from = NOW_MS - range * 86_400_000;
  let rows = ds.rows(ctx).filter((r) => {
    if (ds.scope !== 'none' && ds.wh && warehouse !== 'ALL' && ds.wh(r) !== warehouse) return false;
    if (ds.scope === 'dated' && ds.date && new Date(ds.date(r)).getTime() < from) return false;
    return !filter || filter(r);
  });
  const sf = sortBy && ds.fields.find((f) => f.key === sortBy.key);
  if (sf && sortBy) {
    rows = [...rows].sort((a, b) => {
      const va = rawCell(sf.get(a)), vb = rawCell(sf.get(b));
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sortBy.dir;
    });
  }
  return rows;
}

export function scopeLabel(ds: Dataset, warehouse: 'ALL' | WhCode, range: number) {
  const site = warehouse === 'ALL' ? 'All warehouses' : warehouse;
  if (ds.scope === 'dated') return `${site} · last ${range === 1 ? '24h' : `${range} days`}`;
  if (ds.scope === 'warehouse') return `${site} · snapshot, date range not applied`;
  return 'Not site or date scoped';
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'report';
