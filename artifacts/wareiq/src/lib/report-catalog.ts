// Typed reporting catalog. Every field maps explicitly to a property (or a derived
// value) of a sample dataset exported from ./data. No credentials or connection
// settings are ever exposed here.
import {
  RECEIPTS, PUTAWAY, LOCATIONS, STOCK, PICKS, REPLEN, ORDERS, LOADS, COUNTS, SHIFTS, EXCEPTIONS, BATCHES,
  type WhCode, type Receipt, type PutawayTask, type Location, type StockLine, type Pick, type Replen, type Order,
  type Load, type Count, type Shift, type Exception, type Batch, type EventKind,
} from './data';
import type { Prefs } from './report-context';
import { DEFAULT_REPORT_NAMES } from './default-report-names';

export type FieldKind = 'text' | 'number' | 'decimal' | 'gbp' | 'pct' | 'minutes' | 'date' | 'datetime' | 'bool' | 'list';
export type Cell = string | number | boolean | null | string[];
export interface Field<T> { key: string; label: string; kind: FieldKind; get: (r: T) => Cell }
/** day+warehouse scoping: 'dated' = warehouse and date range, 'warehouse' = site only, 'none' = global */
export type Scope = 'dated' | 'warehouse' | 'none';

export interface CatalogCtx { prefs: Prefs; ownCounts: Record<string, number> }
export interface Dataset<T = unknown> {
  id: string; label: string; description: string; scope: Scope;
  rows: (ctx: CatalogCtx) => T[]; rowKey: (r: T) => string;
  wh?: (r: T) => WhCode; date?: (r: T) => string;
  fields: Field<T>[];
}
export interface DefaultReport { id: string; title: string; description: string; dataset: string; fields: string[]; filter?: (r: unknown) => boolean; sortBy?: { key: string; dir: 1 | -1 } }
export type SectionId =
  | 'dashboard' | 'inbound' | 'putaway' | 'inventory' | 'picking' | 'outbound' | 'dispatch'
  | 'traceability' | 'stock-counts' | 'labour' | 'exceptions' | 'settings';
export interface Section { id: SectionId; label: string; eyebrow: string; overview: string; base: string; datasets: Dataset[]; defaults: DefaultReport[] }

function fld<T>(key: keyof T & string, label: string, kind: FieldKind, get?: (r: T) => Cell): Field<T> {
  return { key, label, kind, get: get ?? ((r: T) => r[key] as unknown as Cell) };
}
function dx<T>(key: string, label: string, kind: FieldKind, get: (r: T) => Cell): Field<T> {
  return { key, label, kind, get };
}
function dataset<T>(d: Dataset<T>): Dataset {
  return d as unknown as Dataset;
}
function rep<T>(d: Omit<DefaultReport, 'filter'> & { filter?: (r: T) => boolean }): DefaultReport {
  return d as DefaultReport;
}
const whF = <T extends { wh: WhCode }>() => fld<T>('wh', 'Warehouse', 'text');

// ---------------- Datasets ----------------
const receipts = dataset<Receipt>({
  id: 'receipts', label: 'Goods receipts', description: 'Supplier deliveries booked against purchase orders.', scope: 'dated',
  rows: () => RECEIPTS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'GRN', 'text'), fld('po', 'Purchase order', 'text'), fld('supplier', 'Supplier', 'text'), whF<Receipt>(),
    fld('date', 'Booked at', 'datetime'), fld('dock', 'Dock', 'text'), fld('lines', 'Lines', 'number'),
    fld('expected', 'Expected units', 'number'), fld('received', 'Received units', 'number'), fld('variance', 'Variance units', 'number'),
    fld('dockToStockMin', 'Dock-to-stock', 'minutes'), fld('status', 'Status', 'text'), fld('receiver', 'Receiver', 'text'),
  ],
});

const putaway = dataset<PutawayTask>({
  id: 'putaway', label: 'Put-away tasks', description: 'Moves from dock to storage location.', scope: 'dated',
  rows: () => PUTAWAY, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Task', 'text'), fld('grn', 'GRN', 'text'), fld('sku', 'SKU', 'text'), fld('name', 'Product', 'text'),
    fld('qty', 'Quantity', 'number'), fld('from', 'From', 'text'), fld('to', 'To location', 'text'), whF<PutawayTask>(),
    fld('date', 'Created at', 'datetime'), fld('minutes', 'Duration', 'minutes'), fld('status', 'Status', 'text'), fld('operator', 'Operator', 'text'),
  ],
});

const locations = dataset<Location>({
  id: 'locations', label: 'Storage locations', description: 'Current capacity snapshot by location. Date range does not apply.', scope: 'warehouse',
  rows: () => LOCATIONS, rowKey: (r) => `${r.wh}-${r.code}`, wh: (r) => r.wh,
  fields: [
    fld('code', 'Location', 'text'), fld('zone', 'Zone', 'text'), whF<Location>(), fld('type', 'Type', 'text'),
    fld('capacity', 'Capacity', 'number'), fld('used', 'Used', 'number'),
    dx<Location>('free', 'Free', 'number', (r) => r.capacity - r.used),
    dx<Location>('utilisation', 'Utilisation', 'pct', (r) => (r.capacity ? Math.round((r.used / r.capacity) * 1000) / 10 : null)),
    fld('blocked', 'Blocked', 'bool'), fld('blockReason', 'Block reason', 'text', (r) => r.blockReason || null),
  ],
});

const stock = dataset<StockLine>({
  id: 'stock', label: 'Stock on hand', description: 'Point-in-time stock by SKU, batch and location. Date range does not apply.', scope: 'warehouse',
  rows: () => STOCK, rowKey: (r) => r.id, wh: (r) => r.wh,
  fields: [
    fld('sku', 'SKU', 'text'), fld('name', 'Product', 'text'), fld('category', 'Category', 'text'), fld('supplier', 'Supplier', 'text'),
    fld('batch', 'Batch', 'text'), fld('location', 'Location', 'text'), whF<StockLine>(),
    fld('onHand', 'On hand', 'number'), fld('allocated', 'Allocated', 'number'), fld('available', 'Available', 'number'),
    fld('expiry', 'Expiry', 'date'), fld('receivedAt', 'Received at', 'date'), fld('ageDays', 'Age (days)', 'number'),
    fld('value', 'Stock value', 'gbp'), fld('status', 'Status', 'text'),
  ],
});

const picks = dataset<Pick>({
  id: 'picks', label: 'Pick lines', description: 'Order lines picked from pick faces.', scope: 'dated',
  rows: () => PICKS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Pick', 'text'), fld('order', 'Order', 'text'), fld('sku', 'SKU', 'text'), fld('name', 'Product', 'text'),
    fld('location', 'Pick face', 'text'), whF<Pick>(), fld('date', 'Picked at', 'datetime'),
    fld('requested', 'Requested', 'number'), fld('picked', 'Picked', 'number'), fld('short', 'Short', 'number'),
    fld('seconds', 'Pick time (s)', 'number'), fld('operator', 'Operator', 'text'), fld('status', 'Status', 'text'),
  ],
});

const replen = dataset<Replen>({
  id: 'replen', label: 'Replenishment tasks', description: 'Pick-face top-ups against min/max levels.', scope: 'dated',
  rows: () => REPLEN, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Task', 'text'), fld('sku', 'SKU', 'text'), fld('name', 'Product', 'text'), fld('pickFace', 'Pick face', 'text'),
    whF<Replen>(), fld('date', 'Raised at', 'datetime'), fld('min', 'Min', 'number'), fld('max', 'Max', 'number'),
    fld('current', 'Current', 'number'), fld('required', 'Required', 'number'), fld('source', 'Source location', 'text'),
    fld('priority', 'Priority', 'text'), fld('status', 'Status', 'text'),
  ],
});

const orders = dataset<Order>({
  id: 'orders', label: 'Customer orders', description: 'Sales orders from receipt to dispatch.', scope: 'dated',
  rows: () => ORDERS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Order', 'text'), fld('customer', 'Customer', 'text'), whF<Order>(), fld('date', 'Received at', 'datetime'),
    fld('promised', 'Promised by', 'datetime'), fld('lines', 'Lines', 'number'), fld('units', 'Units ordered', 'number'),
    fld('unitsShipped', 'Units shipped', 'number'), fld('status', 'Status', 'text'), fld('cycleHrs', 'Cycle time (h)', 'decimal'),
    fld('fillRate', 'Fill rate', 'pct', (r) => (r.status === 'Dispatched' ? r.fillRate : null)), fld('otif', 'On time in full', 'bool'), fld('route', 'Route', 'text'),
  ],
});

const loads = dataset<Load>({
  id: 'loads', label: 'Trailer loads', description: 'Loads by route, vehicle and carrier.', scope: 'dated',
  rows: () => LOADS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Load', 'text'), fld('route', 'Route', 'text'), fld('vehicle', 'Vehicle', 'text'), fld('carrier', 'Carrier', 'text'),
    whF<Load>(), fld('date', 'Planned at', 'datetime'), fld('cutoff', 'Cut-off', 'datetime'), fld('departed', 'Departed', 'datetime'),
    fld('orders', 'Orders', 'number'), fld('pallets', 'Pallets', 'number'), fld('loadedPct', 'Loaded', 'pct'),
    fld('discrepancies', 'Discrepancies', 'number'), fld('status', 'Status', 'text'),
  ],
});

interface BatchRow { batch: Batch; remainingQty: number; last: { at: string; kind: EventKind } | null }
const batches = dataset<BatchRow>({
  id: 'batches', label: 'Batches', description: 'One row per traced batch or serial. Site filter applies; date range does not.', scope: 'warehouse',
  rows: () => BATCHES.map((b) => ({ batch: b, remainingQty: b.remaining.reduce((a, x) => a + x.qty, 0), last: b.events.length ? b.events[b.events.length - 1] : null })),
  rowKey: (r) => `${r.batch.batch}-${r.batch.sku}-${r.batch.grn}`, wh: (r) => r.batch.wh,
  fields: [
    dx<BatchRow>('batch', 'Batch', 'text', (r) => r.batch.batch), dx<BatchRow>('serial', 'Serial', 'text', (r) => r.batch.serial),
    dx<BatchRow>('sku', 'SKU', 'text', (r) => r.batch.sku), dx<BatchRow>('name', 'Product', 'text', (r) => r.batch.name),
    dx<BatchRow>('barcode', 'Barcode', 'text', (r) => r.batch.barcode), dx<BatchRow>('category', 'Category', 'text', (r) => r.batch.category),
    dx<BatchRow>('supplier', 'Supplier', 'text', (r) => r.batch.supplier), dx<BatchRow>('wh', 'Warehouse', 'text', (r) => r.batch.wh),
    dx<BatchRow>('grn', 'GRN', 'text', (r) => r.batch.grn), dx<BatchRow>('po', 'Purchase order', 'text', (r) => r.batch.po),
    dx<BatchRow>('expiry', 'Expiry', 'date', (r) => r.batch.expiry), dx<BatchRow>('receivedQty', 'Received qty', 'number', (r) => r.batch.receivedQty),
    dx<BatchRow>('remainingQty', 'Remaining qty', 'number', (r) => r.remainingQty),
    dx<BatchRow>('remainingLocations', 'Remaining at', 'list', (r) => r.batch.remaining.map((x) => `${x.location} (${x.qty})`)),
    dx<BatchRow>('eventCount', 'Movements', 'number', (r) => r.batch.events.length),
    dx<BatchRow>('lastEventAt', 'Last movement', 'datetime', (r) => r.last?.at ?? null),
    dx<BatchRow>('lastEventKind', 'Last movement type', 'text', (r) => r.last?.kind ?? null),
    dx<BatchRow>('orders', 'Orders', 'list', (r) => r.batch.orders), dx<BatchRow>('shipments', 'Shipments', 'list', (r) => r.batch.shipments),
  ],
});

interface EventRow { b: Batch; i: number; at: string; kind: EventKind; qty: number; location: string; ref: string; operator: string; note: string | null }
const events = dataset<EventRow>({
  id: 'events', label: 'Batch movements', description: 'Every recorded movement for traced batches.', scope: 'dated',
  rows: () => BATCHES.flatMap((b) => b.events.map((e, i) => ({ b, i, at: e.at, kind: e.kind, qty: e.qty, location: e.location, ref: e.ref, operator: e.operator, note: e.note ?? null }))),
  rowKey: (r) => `${r.b.batch}-${r.b.grn}-${r.i}`, wh: (r) => r.b.wh, date: (r) => r.at,
  fields: [
    dx<EventRow>('at', 'Moved at', 'datetime', (r) => r.at), dx<EventRow>('batch', 'Batch', 'text', (r) => r.b.batch),
    dx<EventRow>('sku', 'SKU', 'text', (r) => r.b.sku), dx<EventRow>('name', 'Product', 'text', (r) => r.b.name),
    dx<EventRow>('wh', 'Warehouse', 'text', (r) => r.b.wh), dx<EventRow>('kind', 'Movement', 'text', (r) => r.kind),
    dx<EventRow>('qty', 'Quantity', 'number', (r) => r.qty), dx<EventRow>('location', 'Location', 'text', (r) => r.location),
    dx<EventRow>('ref', 'Reference', 'text', (r) => r.ref), dx<EventRow>('operator', 'Operator', 'text', (r) => r.operator),
    dx<EventRow>('note', 'Note', 'text', (r) => r.note),
  ],
});

const counts = dataset<Count>({
  id: 'counts', label: 'Count lines', description: 'Cycle-count results and adjustment approvals.', scope: 'dated',
  rows: () => COUNTS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Count', 'text'), fld('plan', 'Plan', 'text'), fld('location', 'Location', 'text'), fld('sku', 'SKU', 'text'),
    fld('name', 'Product', 'text'), fld('category', 'Category', 'text'), whF<Count>(), fld('date', 'Counted at', 'datetime'),
    fld('system', 'System qty', 'number'), fld('counted', 'Counted qty', 'number'), fld('variance', 'Variance', 'number'),
    fld('varianceValue', 'Variance value', 'gbp'), fld('reason', 'Reason', 'text', (r) => (r.reason === '—' ? null : r.reason)),
    fld('approval', 'Approval', 'text'), fld('counter', 'Counter', 'text'), fld('repeat', 'Repeat variance', 'bool'),
  ],
});

const shifts = dataset<Shift>({
  id: 'shifts', label: 'Operator shifts', description: 'Hours worked and work completed per operator shift.', scope: 'dated',
  rows: () => SHIFTS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('operator', 'Operator', 'text'), fld('role', 'Role', 'text'), whF<Shift>(), fld('date', 'Shift date', 'datetime'),
    fld('hours', 'Hours', 'decimal'), fld('tasks', 'Tasks', 'number'), fld('lines', 'Lines', 'number'), fld('units', 'Units', 'number'),
    fld('idleMin', 'Idle', 'minutes'), dx<Shift>('linesPerHour', 'Lines per hour', 'decimal', (r) => Math.round((r.lines / r.hours) * 10) / 10),
  ],
});

const exceptions = dataset<Exception>({
  id: 'exceptions', label: 'Exceptions', description: 'Operational issues raised across the warehouse.', scope: 'dated',
  rows: () => EXCEPTIONS, rowKey: (r) => r.id, wh: (r) => r.wh, date: (r) => r.date,
  fields: [
    fld('id', 'Exception', 'text'), fld('type', 'Type', 'text'), fld('severity', 'Severity', 'text'), fld('ref', 'Reference', 'text'),
    whF<Exception>(), fld('date', 'Raised at', 'datetime'), fld('owner', 'Owner', 'text'), fld('status', 'Status', 'text'), fld('detail', 'Detail', 'text'),
  ],
});

interface DayRow { day: string; wh: WhCode; ordersIn: number; dispatched: number; units: number; shipped: number; otif: number | null; hours: number; lines: number; operators: number }
const daily = dataset<DayRow>({
  id: 'daily', label: 'Daily site summary', description: 'Orders and labour rolled up per day and warehouse.', scope: 'dated',
  rows: () => {
    const m = new Map<string, DayRow & { otifN: number; otifY: number; ops: Set<string> }>();
    const get = (iso: string, wh: WhCode) => {
      const day = iso.slice(0, 10);
      const k = `${day}|${wh}`;
      let r = m.get(k);
      if (!r) { r = { day, wh, ordersIn: 0, dispatched: 0, units: 0, shipped: 0, otif: null, hours: 0, lines: 0, operators: 0, otifN: 0, otifY: 0, ops: new Set() }; m.set(k, r); }
      return r;
    };
    for (const o of ORDERS) {
      const r = get(o.date, o.wh);
      r.ordersIn++; r.units += o.units; r.shipped += o.unitsShipped;
      if (o.status === 'Dispatched') r.dispatched++;
      if (o.otif != null) { r.otifN++; if (o.otif) r.otifY++; }
    }
    for (const sh of SHIFTS) {
      const r = get(sh.date, sh.wh);
      r.hours += sh.hours; r.lines += sh.lines; r.ops.add(sh.operator);
    }
    return [...m.values()].map(({ otifN, otifY, ops, ...r }) => ({ ...r, otif: otifN ? Math.round((otifY / otifN) * 1000) / 10 : null, operators: ops.size })).sort((a, b) => b.day.localeCompare(a.day) || a.wh.localeCompare(b.wh));
  },
  rowKey: (r) => `${r.day}-${r.wh}`, wh: (r) => r.wh, date: (r) => `${r.day}T12:00:00.000Z`,
  fields: [
    fld('day', 'Day', 'date'), whF<DayRow>(), fld('ordersIn', 'Orders received', 'number'), fld('dispatched', 'Orders dispatched', 'number'),
    fld('units', 'Units ordered', 'number'), fld('shipped', 'Units shipped', 'number'), fld('otif', 'OTIF', 'pct'),
    fld('hours', 'Labour hours', 'decimal'), fld('lines', 'Lines handled', 'number'), fld('operators', 'Operators on shift', 'number'),
  ],
});

// ---- Settings: safe, non-sensitive reporting preferences and readiness only ----
interface PrefRow { setting: string; value: string; defaultValue: string; changed: boolean; scope: string }
const DEFAULT_PREF_VIEW: Prefs = { refreshInterval: '15', queryTimeoutSec: 30, defaultRange: 30, targetPickAccuracy: 99.2, targetFillRate: 97.5, targetDockToStockMin: 120 };
const prefRows = (p: Prefs): PrefRow[] => {
  const ri = (v: Prefs['refreshInterval']) => (v === 'manual' ? 'Manual' : `Every ${v} min`);
  const row = (setting: string, value: string, defaultValue: string): PrefRow => ({ setting, value, defaultValue, changed: value !== defaultValue, scope: 'This browser' });
  return [
    row('Auto refresh', ri(p.refreshInterval), ri(DEFAULT_PREF_VIEW.refreshInterval)),
    row('Query timeout', `${p.queryTimeoutSec} s`, `${DEFAULT_PREF_VIEW.queryTimeoutSec} s`),
    row('Default date range', `${p.defaultRange} days`, `${DEFAULT_PREF_VIEW.defaultRange} days`),
    row('Pick accuracy target', `${p.targetPickAccuracy}%`, `${DEFAULT_PREF_VIEW.targetPickAccuracy}%`),
    row('Fill rate target', `${p.targetFillRate}%`, `${DEFAULT_PREF_VIEW.targetFillRate}%`),
    row('Dock-to-stock target', `${p.targetDockToStockMin} min`, `${DEFAULT_PREF_VIEW.targetDockToStockMin} min`),
  ];
};
const prefs = dataset<PrefRow>({
  id: 'prefs', label: 'Report preferences', description: 'Non-sensitive report behaviour stored in this browser. Connection details are never included.', scope: 'none',
  rows: (ctx) => prefRows(ctx.prefs), rowKey: (r) => r.setting,
  fields: [fld('setting', 'Setting', 'text'), fld('value', 'Current value', 'text'), fld('defaultValue', 'Default', 'text'), fld('changed', 'Changed from default', 'bool'), fld('scope', 'Stored in', 'text')],
});

interface ReadyRow { section: string; datasets: string[]; fieldCount: number; defaults: number; own: number; dateScope: boolean; siteScope: boolean; source: string; live: string }
const readiness = dataset<ReadyRow>({
  id: 'readiness', label: 'Section reporting readiness', description: 'What each section can report on today, and where the data comes from.', scope: 'none',
  rows: (ctx) => SECTIONS.map((s) => ({
    section: s.label, datasets: s.datasets.map((d) => d.label), fieldCount: s.datasets.reduce((a, d) => a + d.fields.length, 0),
    defaults: s.defaults.length, own: ctx.ownCounts[s.id] ?? 0,
    dateScope: s.datasets.some((d) => d.scope === 'dated'), siteScope: s.datasets.some((d) => d.scope !== 'none'),
    source: 'Generated sample data', live: 'Not connected',
  })),
  rowKey: (r) => r.section,
  fields: [
    fld('section', 'Section', 'text'), fld('datasets', 'Datasets', 'list'), fld('fieldCount', 'Reportable fields', 'number'),
    fld('defaults', 'Default reports', 'number'), fld('own', 'Own reports (this browser)', 'number'),
    fld('dateScope', 'Date range applies', 'bool'), fld('siteScope', 'Site filter applies', 'bool'), fld('source', 'Data source', 'text'), fld('live', 'Live WMS', 'text'),
  ],
});

// ---------------- Sections ----------------
export const SECTIONS: Section[] = [
  {
    id: 'dashboard', label: 'Executive dashboard', eyebrow: '01 · Executive', overview: '/', base: '/dashboard', datasets: [daily, orders, shifts],
    defaults: [
      { id: 'daily-site-summary', title: 'Daily site summary', description: 'Orders in and out, OTIF and labour hours per day and warehouse.', dataset: 'daily', fields: ['day', 'wh', 'ordersIn', 'dispatched', 'units', 'shipped', 'otif', 'hours', 'lines'] },
      rep<Order>({ id: 'otif-failures', title: 'OTIF failures', description: 'Dispatched orders that missed on time in full.', dataset: 'orders', fields: ['id', 'customer', 'wh', 'promised', 'units', 'unitsShipped', 'fillRate', 'route'], filter: (r) => r.otif === false }),
      { id: 'labour-by-shift', title: 'Labour hours by shift', description: 'Hours and lines handled per operator shift.', dataset: 'shifts', fields: ['date', 'operator', 'role', 'wh', 'hours', 'lines', 'linesPerHour'], sortBy: { key: 'date', dir: -1 } },
    ],
  },
  {
    id: 'inbound', label: 'Inbound / receiving', eyebrow: '02 · Inbound', overview: '/inbound', base: '/inbound', datasets: [receipts],
    defaults: [
      { id: 'receipt-register', title: 'Receipt register', description: 'Every goods receipt in range with expected and received units.', dataset: 'receipts', fields: ['id', 'po', 'supplier', 'wh', 'date', 'expected', 'received', 'status'], sortBy: { key: 'date', dir: -1 } },
      rep<Receipt>({ id: 'receiving-discrepancies', title: 'Receiving discrepancies', description: 'Booked receipts where received units differ from the purchase order.', dataset: 'receipts', fields: ['id', 'po', 'supplier', 'wh', 'expected', 'received', 'variance', 'receiver'], filter: (r) => r.variance !== 0 && r.status !== 'Outstanding' }),
      rep<Receipt>({ id: 'outstanding-deliveries', title: 'Outstanding deliveries', description: 'Deliveries expected but not yet booked in.', dataset: 'receipts', fields: ['id', 'po', 'supplier', 'wh', 'date', 'dock', 'expected'], filter: (r) => r.status === 'Outstanding' }),
      { id: 'dock-to-stock', title: 'Dock-to-stock times', description: 'Time from dock arrival to stock available, slowest first.', dataset: 'receipts', fields: ['id', 'supplier', 'wh', 'dock', 'lines', 'dockToStockMin', 'receiver'], sortBy: { key: 'dockToStockMin', dir: -1 } },
    ],
  },
  {
    id: 'putaway', label: 'Put-away & locations', eyebrow: '03 · Put-away', overview: '/putaway', base: '/putaway', datasets: [putaway, locations],
    defaults: [
      rep<PutawayTask>({ id: 'open-putaway', title: 'Open put-away tasks', description: 'Pending and in-progress moves still sitting on the dock.', dataset: 'putaway', fields: ['id', 'grn', 'sku', 'name', 'qty', 'from', 'to', 'wh', 'date', 'status'], filter: (r) => r.status !== 'Completed' }),
      { id: 'location-utilisation', title: 'Location utilisation', description: 'Capacity used per location, fullest first.', dataset: 'locations', fields: ['code', 'zone', 'wh', 'type', 'capacity', 'used', 'free', 'utilisation'], sortBy: { key: 'utilisation', dir: -1 } },
      rep<Location>({ id: 'blocked-locations', title: 'Blocked locations', description: 'Locations unavailable for put-away and why.', dataset: 'locations', fields: ['code', 'zone', 'wh', 'type', 'blockReason'], filter: (r) => r.blocked }),
    ],
  },
  {
    id: 'inventory', label: 'Inventory', eyebrow: '04 · Inventory', overview: '/inventory', base: '/inventory', datasets: [stock],
    defaults: [
      { id: 'stock-valuation', title: 'Stock valuation', description: 'On-hand units and value by SKU, batch and location.', dataset: 'stock', fields: ['sku', 'name', 'category', 'wh', 'location', 'onHand', 'available', 'value'], sortBy: { key: 'value', dir: -1 } },
      rep<StockLine>({ id: 'expiry-watch', title: 'Expiry watch', description: 'Batches expired or within 30 days of expiry.', dataset: 'stock', fields: ['sku', 'name', 'batch', 'location', 'wh', 'onHand', 'expiry', 'status'], filter: (r) => r.status === 'Expired' || r.status === 'Near expiry', sortBy: { key: 'expiry', dir: 1 } }),
      rep<StockLine>({ id: 'stock-integrity', title: 'Negative and held stock', description: 'Lines with negative on-hand or on quality hold.', dataset: 'stock', fields: ['sku', 'name', 'batch', 'location', 'wh', 'onHand', 'allocated', 'status'], filter: (r) => r.status === 'Negative' || r.status === 'Quality hold' }),
      { id: 'stock-ageing', title: 'Stock ageing', description: 'Oldest stock first, with value at risk.', dataset: 'stock', fields: ['sku', 'name', 'supplier', 'wh', 'receivedAt', 'ageDays', 'onHand', 'value'], sortBy: { key: 'ageDays', dir: -1 } },
    ],
  },
  {
    id: 'picking', label: 'Replenishment & picking', eyebrow: '05 · Picking', overview: '/picking', base: '/picking', datasets: [picks, replen],
    defaults: [
      rep<Pick>({ id: 'short-picks', title: 'Short and corrected picks', description: 'Lines picked short or corrected after a mis-pick.', dataset: 'picks', fields: ['id', 'order', 'sku', 'name', 'location', 'wh', 'requested', 'picked', 'short', 'operator', 'status'], filter: (r) => r.status === 'Short pick' || r.status === 'Mis-pick corrected' }),
      { id: 'pick-log', title: 'Pick log', description: 'All pick lines with timings.', dataset: 'picks', fields: ['id', 'order', 'sku', 'wh', 'date', 'requested', 'picked', 'seconds', 'operator'], sortBy: { key: 'date', dir: -1 } },
      rep<Replen>({ id: 'replen-queue', title: 'Replenishment queue', description: 'Pick faces below max still awaiting replenishment.', dataset: 'replen', fields: ['id', 'sku', 'name', 'pickFace', 'wh', 'current', 'min', 'required', 'source', 'priority', 'status'], filter: (r) => r.status !== 'Completed' }),
    ],
  },
  {
    id: 'outbound', label: 'Order fulfilment', eyebrow: '06 · Outbound', overview: '/outbound', base: '/outbound', datasets: [orders],
    defaults: [
      { id: 'order-book', title: 'Order book', description: 'All orders in range with status and promised date.', dataset: 'orders', fields: ['id', 'customer', 'wh', 'date', 'promised', 'lines', 'units', 'status'], sortBy: { key: 'date', dir: -1 } },
      rep<Order>({ id: 'open-orders', title: 'Open and backordered orders', description: 'Orders not yet dispatched.', dataset: 'orders', fields: ['id', 'customer', 'wh', 'date', 'promised', 'units', 'status', 'route'], filter: (r) => r.status !== 'Dispatched', sortBy: { key: 'promised', dir: 1 } }),
      rep<Order>({ id: 'dispatched-performance', title: 'Dispatched order performance', description: 'Fill rate, cycle time and OTIF for dispatched orders.', dataset: 'orders', fields: ['id', 'customer', 'wh', 'units', 'unitsShipped', 'fillRate', 'cycleHrs', 'otif'], filter: (r) => r.status === 'Dispatched' }),
    ],
  },
  {
    id: 'dispatch', label: 'Loading & dispatch', eyebrow: '07 · Dispatch', overview: '/dispatch', base: '/dispatch', datasets: [loads],
    defaults: [
      { id: 'load-register', title: 'Load register', description: 'Every load in range with fill and departure.', dataset: 'loads', fields: ['id', 'route', 'vehicle', 'carrier', 'wh', 'cutoff', 'departed', 'pallets', 'loadedPct', 'status'], sortBy: { key: 'cutoff', dir: -1 } },
      rep<Load>({ id: 'missed-cutoffs', title: 'Missed cut-offs', description: 'Loads that left after their route cut-off.', dataset: 'loads', fields: ['id', 'route', 'carrier', 'wh', 'cutoff', 'departed', 'orders'], filter: (r) => r.status === 'Missed cut-off' }),
      rep<Load>({ id: 'load-discrepancies', title: 'Loading discrepancies', description: 'Loads with pallet or order discrepancies.', dataset: 'loads', fields: ['id', 'route', 'vehicle', 'wh', 'orders', 'pallets', 'discrepancies', 'status'], filter: (r) => r.discrepancies > 0 }),
    ],
  },
  {
    id: 'traceability', label: 'Traceability', eyebrow: '08 · Traceability', overview: '/traceability', base: '/traceability', datasets: [batches, events],
    defaults: [
      { id: 'batch-register', title: 'Batch register', description: 'Every traced batch with source receipt and remaining quantity.', dataset: 'batches', fields: ['batch', 'sku', 'name', 'supplier', 'wh', 'grn', 'po', 'receivedQty', 'remainingQty', 'expiry'] },
      { id: 'batch-distribution', title: 'Batch distribution', description: 'Where each batch went: orders and shipments.', dataset: 'batches', fields: ['batch', 'sku', 'name', 'wh', 'orders', 'shipments', 'remainingLocations'] },
      rep<EventRow>({ id: 'adjustment-trail', title: 'Count and adjustment trail', description: 'Counts and stock adjustments recorded against batches.', dataset: 'events', fields: ['at', 'batch', 'sku', 'wh', 'kind', 'qty', 'location', 'ref', 'note'], filter: (r) => r.kind === 'Adjusted' || r.kind === 'Counted', sortBy: { key: 'at', dir: -1 } }),
    ],
  },
  {
    id: 'stock-counts', label: 'Counts & adjustments', eyebrow: '09 · Counts', overview: '/stock-counts', base: '/stock-counts', datasets: [counts],
    defaults: [
      rep<Count>({ id: 'count-variances', title: 'Count variances', description: 'Counts where the counted quantity differs from system.', dataset: 'counts', fields: ['id', 'location', 'sku', 'name', 'wh', 'system', 'counted', 'variance', 'varianceValue', 'reason'], filter: (r) => r.variance !== 0, sortBy: { key: 'varianceValue', dir: 1 } }),
      rep<Count>({ id: 'pending-approvals', title: 'Adjustments awaiting approval', description: 'Variances not yet approved or rejected.', dataset: 'counts', fields: ['id', 'sku', 'wh', 'date', 'variance', 'varianceValue', 'reason', 'counter'], filter: (r) => r.approval === 'Pending' }),
      rep<Count>({ id: 'repeat-variances', title: 'Repeat variances', description: 'Locations flagged for recurring count differences.', dataset: 'counts', fields: ['id', 'location', 'sku', 'wh', 'variance', 'reason', 'approval'], filter: (r) => r.repeat }),
    ],
  },
  {
    id: 'labour', label: 'Labour & productivity', eyebrow: '10 · People', overview: '/labour', base: '/labour', datasets: [shifts],
    defaults: [
      { id: 'shift-productivity', title: 'Shift productivity', description: 'Lines per hour per operator shift, best first.', dataset: 'shifts', fields: ['operator', 'role', 'wh', 'date', 'hours', 'lines', 'linesPerHour'], sortBy: { key: 'linesPerHour', dir: -1 } },
      { id: 'idle-time', title: 'Idle time', description: 'Shifts with the most idle minutes.', dataset: 'shifts', fields: ['operator', 'role', 'wh', 'date', 'hours', 'idleMin'], sortBy: { key: 'idleMin', dir: -1 } },
    ],
  },
  {
    id: 'exceptions', label: 'Exceptions', eyebrow: '11 · Exceptions', overview: '/exceptions', base: '/exceptions', datasets: [exceptions],
    defaults: [
      rep<Exception>({ id: 'open-exceptions', title: 'Open exceptions', description: 'Everything not yet resolved, newest first.', dataset: 'exceptions', fields: ['id', 'type', 'severity', 'ref', 'wh', 'date', 'owner', 'status'], filter: (r) => r.status !== 'Resolved', sortBy: { key: 'date', dir: -1 } }),
      rep<Exception>({ id: 'critical-high', title: 'Critical and high severity', description: 'The issues that need someone today.', dataset: 'exceptions', fields: ['id', 'type', 'severity', 'wh', 'owner', 'status', 'detail'], filter: (r) => r.severity === 'Critical' || r.severity === 'High' }),
      { id: 'exception-log', title: 'Exception log', description: 'Full log with detail text.', dataset: 'exceptions', fields: ['id', 'type', 'severity', 'ref', 'wh', 'date', 'status', 'detail'] },
    ],
  },
  {
    id: 'settings', label: 'Settings', eyebrow: '12 · Administration', overview: '/settings', base: '/settings', datasets: [prefs, readiness],
    defaults: [
      { id: 'report-preferences', title: 'Report preferences', description: 'Refresh, timeout, range and targets compared with defaults. No connection details.', dataset: 'prefs', fields: ['setting', 'value', 'defaultValue', 'changed', 'scope'] },
      { id: 'section-readiness', title: 'Section reporting readiness', description: 'Datasets, fields and report counts available per section.', dataset: 'readiness', fields: ['section', 'datasets', 'fieldCount', 'defaults', 'own', 'dateScope', 'siteScope', 'source', 'live'] },
    ],
  },
];

// Published defaults are the user's name-only catalogue, not executable templates.
for (const section of SECTIONS) {
  section.defaults = DEFAULT_REPORT_NAMES[section.id].map((title, index) => ({
    id: `${section.id}-${index + 1}`,
    title,
    description: 'Not developed yet',
    dataset: '',
    fields: [],
  }));
}

export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const getSection = (id: string) => SECTIONS.find((s) => s.id === id);
export const getDataset = (s: Section, id: string) => s.datasets.find((d) => d.id === id);
export function sectionForPath(loc: string): Section | undefined {
  return SECTIONS.find((s) => loc === s.overview || loc === s.base || loc.startsWith(`${s.base}/`));
}
