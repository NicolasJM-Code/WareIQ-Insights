// SAMPLE DATA ONLY. Deterministically generated demonstration records.
// No live WMS connection exists; nothing here is read from PostgreSQL.

let s = 917_331;
const rnd = () => {
  s = (s * 16807) % 2147483647;
  return (s - 1) / 2147483646;
};
const int = (a: number, b: number) => Math.floor(rnd() * (b - a + 1)) + a;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const pad = (n: number, l = 5) => String(n).padStart(l, '0');

const HOUR = 3_600_000;
const NOW = (() => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.getTime();
})();
const ago = (maxDays: number) => new Date(NOW - int(1, maxDays * 24) * HOUR).toISOString();
const plusH = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * HOUR).toISOString();

export const WAREHOUSES = [
  { code: 'TPK', name: 'Trafford Park', region: 'North West' },
  { code: 'HMH', name: 'Hams Hall', region: 'Midlands' },
  { code: 'AVM', name: 'Avonmouth', region: 'South West' },
] as const;
export type WhCode = (typeof WAREHOUSES)[number]['code'];
const wh = () => pick(WAREHOUSES).code as WhCode;

export const SUPPLIERS = ['Halden Foods', 'Morrow & Pike', 'Brightwater Bottling', 'Kessock Paper Co', 'Norfell Household', 'Ardent Pet Supplies', 'Ouseburn Dairy', 'Calder Hardware'];
const CATEGORIES = ['Ambient grocery', 'Chilled', 'Household', 'Paper', 'Beverages', 'Pet care', 'Hardware'];
const NAMES = ['Oat crackers 300g', 'Basmati rice 2kg', 'Sparkling water 6x1L', 'Kitchen roll 4pk', 'Laundry pods 38', 'Dog biscuits 1.5kg', 'Greek yoghurt 500g', 'Wall plugs 100pk', 'Tomato passata 690g', 'Toilet tissue 9pk', 'Apple juice 1L', 'Cat litter 10L', 'Butter 250g', 'Bin liners 50L', 'Penne pasta 1kg', 'Orange squash 1.5L', 'Washing-up liquid 900ml', 'Wood screws 4x40', 'Cheddar 400g', 'Cold brew 4x250ml', 'Porridge oats 1kg', 'Hand soap 500ml', 'Tea bags 240', 'Masking tape 50m'];
const OPERATORS = ['Priya Nandakumar', 'Tomasz Wilk', 'Gemma Hollis', 'Kwame Asante', 'Ruth Calloway', 'Dariusz Nowak', 'Aisling Brennan', 'Marcus Oduya', 'Shona MacRae', 'Bilal Chaudhry', 'Elena Petrova', 'Craig Fenwick', 'Joy Adebayo', 'Liam Gorman', 'Hannah Pruitt', 'Yusuf Demir'];
const CUSTOMERS = ['Fennick Stores', 'Lowther Co-op', 'Barrow Street Market', 'Pennine Convenience', 'Saltmarsh Foodhall', 'Ashby Wholesale', 'Gilt & Grain', 'Tidewater Retail'];
const ROUTES = ['NW-01 Manchester', 'NW-04 Preston', 'MD-02 Coventry', 'MD-07 Leicester', 'SW-03 Bristol', 'SW-06 Exeter', 'NE-02 Leeds'];
const CARRIERS = ['Own fleet', 'Kinross Haulage', 'Redbank Logistics', 'Pallet Nexus'];

export interface Product { sku: string; name: string; category: string; barcode: string; supplier: string; unitCost: number }
export const PRODUCTS: Product[] = NAMES.map((name, i) => ({
  sku: `SKU-${pad(10230 + i * 17)}`,
  name,
  category: CATEGORIES[i % CATEGORIES.length],
  barcode: `50${pad(int(10000, 99999))}${pad(int(10000, 99999))}${int(0, 9)}`,
  supplier: SUPPLIERS[i % SUPPLIERS.length],
  unitCost: Math.round((1.2 + rnd() * 14) * 100) / 100,
}));
const product = () => pick(PRODUCTS);
const loc = (zone?: string) => `${zone ?? pick(['A', 'B', 'C', 'D', 'P'])}-${pad(int(1, 24), 2)}-${pad(int(1, 9), 2)}-${pick(['A', 'B', 'C', 'D'])}`;

// ---------- Inbound ----------
export interface Receipt { id: string; po: string; supplier: string; wh: WhCode; date: string; dock: string; lines: number; expected: number; received: number; variance: number; dockToStockMin: number | null; status: 'Received' | 'Partial' | 'Over-received' | 'Outstanding'; receiver: string }
export const RECEIPTS: Receipt[] = Array.from({ length: 170 }, (_, i) => {
  const expected = int(40, 1400);
  const r = rnd();
  const status: Receipt['status'] = r < 0.62 ? 'Received' : r < 0.8 ? 'Partial' : r < 0.88 ? 'Over-received' : 'Outstanding';
  const received = status === 'Received' ? expected : status === 'Partial' ? Math.round(expected * (0.55 + rnd() * 0.4)) : status === 'Over-received' ? expected + int(2, 40) : 0;
  return { id: `GRN-${pad(48120 + i)}`, po: `PO-${pad(77300 + int(0, 900))}`, supplier: pick(SUPPLIERS), wh: wh(), date: ago(90), dock: `Dock ${int(1, 12)}`, lines: int(1, 18), expected, received, variance: received - expected, dockToStockMin: status === 'Outstanding' ? null : int(38, 410), status, receiver: pick(OPERATORS) };
});

// ---------- Put-away & locations ----------
export interface PutawayTask { id: string; grn: string; sku: string; name: string; qty: number; from: string; to: string; wh: WhCode; date: string; minutes: number | null; status: 'Completed' | 'In progress' | 'Pending'; operator: string }
export const PUTAWAY: PutawayTask[] = Array.from({ length: 190 }, (_, i) => {
  const p = product();
  const r = rnd();
  const status: PutawayTask['status'] = r < 0.74 ? 'Completed' : r < 0.86 ? 'In progress' : 'Pending';
  return { id: `PA-${pad(30410 + i)}`, grn: pick(RECEIPTS).id, sku: p.sku, name: p.name, qty: int(6, 240), from: `Dock ${int(1, 12)}`, to: loc(), wh: wh(), date: ago(90), minutes: status === 'Completed' ? int(6, 180) : null, status, operator: pick(OPERATORS) };
});
export interface Location { code: string; zone: string; wh: WhCode; type: 'Pallet racking' | 'Shelf' | 'Pick face' | 'Bulk floor'; capacity: number; used: number; blocked: boolean; blockReason: string }
export const LOCATIONS: Location[] = Array.from({ length: 140 }, () => {
  const zone = pick(['A', 'B', 'C', 'D', 'P']);
  const type: Location['type'] = zone === 'P' ? 'Pick face' : pick(['Pallet racking', 'Pallet racking', 'Shelf', 'Bulk floor']);
  const capacity = type === 'Pick face' ? int(40, 120) : type === 'Shelf' ? int(60, 200) : int(200, 960);
  const blocked = rnd() < 0.08;
  return { code: loc(zone), zone, wh: wh(), type, capacity, used: Math.min(capacity, Math.round(capacity * rnd() * 1.05)), blocked, blockReason: blocked ? pick(['Damaged beam', 'Count in progress', 'Spill clean-up', 'Racking inspection', 'Quality hold']) : '' };
});

// ---------- Inventory ----------
export interface StockLine { id: string; sku: string; name: string; category: string; supplier: string; batch: string; location: string; wh: WhCode; onHand: number; allocated: number; available: number; expiry: string | null; receivedAt: string; ageDays: number; value: number; status: 'OK' | 'Near expiry' | 'Expired' | 'Negative' | 'Quality hold' }
export const STOCK: StockLine[] = Array.from({ length: 220 }, (_, i) => {
  const p = product();
  const receivedAt = ago(180);
  const ageDays = Math.round((NOW - new Date(receivedAt).getTime()) / (24 * HOUR));
  const perishable = ['Chilled', 'Ambient grocery', 'Beverages', 'Pet care'].includes(p.category);
  const expiry = perishable ? new Date(NOW + int(-12, 240) * 24 * HOUR).toISOString() : null;
  let onHand = int(0, 1800);
  if (rnd() < 0.03) onHand = -int(1, 24);
  const allocated = onHand > 0 ? Math.min(onHand, int(0, Math.round(onHand * 0.7))) : 0;
  const daysLeft = expiry ? (new Date(expiry).getTime() - NOW) / (24 * HOUR) : 999;
  const status: StockLine['status'] = onHand < 0 ? 'Negative' : daysLeft < 0 ? 'Expired' : daysLeft < 30 ? 'Near expiry' : rnd() < 0.04 ? 'Quality hold' : 'OK';
  return { id: `STK-${i}`, sku: p.sku, name: p.name, category: p.category, supplier: p.supplier, batch: `L${pad(int(2400, 2690), 4)}-${String.fromCharCode(65 + int(0, 7))}${int(10, 99)}`, location: loc(), wh: wh(), onHand, allocated, available: onHand - allocated, expiry, receivedAt, ageDays, value: Math.round(onHand * p.unitCost * 100) / 100, status };
});

// ---------- Picking & replenishment ----------
export interface Pick { id: string; order: string; sku: string; name: string; location: string; wh: WhCode; date: string; requested: number; picked: number; short: number; seconds: number; operator: string; status: 'Picked' | 'Short pick' | 'Mis-pick corrected' | 'Outstanding' }
export const PICKS: Pick[] = Array.from({ length: 260 }, (_, i) => {
  const p = product();
  const requested = int(1, 48);
  const r = rnd();
  const status: Pick['status'] = r < 0.82 ? 'Picked' : r < 0.9 ? 'Short pick' : r < 0.94 ? 'Mis-pick corrected' : 'Outstanding';
  const picked = status === 'Short pick' ? int(0, requested - 1) : status === 'Outstanding' ? 0 : requested;
  return { id: `PK-${pad(91200 + i)}`, order: `SO-${pad(240100 + int(0, 220))}`, sku: p.sku, name: p.name, location: loc('P'), wh: wh(), date: ago(90), requested, picked, short: status === 'Outstanding' ? 0 : requested - picked, seconds: int(14, 160), operator: pick(OPERATORS), status };
});
export interface Replen { id: string; sku: string; name: string; pickFace: string; wh: WhCode; date: string; min: number; max: number; current: number; required: number; source: string; priority: 'Urgent' | 'High' | 'Normal'; status: 'Required' | 'Released' | 'Completed' }
export const REPLEN: Replen[] = Array.from({ length: 80 }, (_, i) => {
  const p = product();
  const min = int(12, 60);
  const max = min * int(3, 5);
  const current = int(0, Math.round(min * 1.4));
  return { id: `RP-${pad(5100 + i)}`, sku: p.sku, name: p.name, pickFace: loc('P'), wh: wh(), date: ago(30), min, max, current, required: Math.max(0, max - current), source: loc(pick(['A', 'B', 'C'])), priority: current === 0 ? 'Urgent' : current < min ? 'High' : 'Normal', status: pick(['Required', 'Required', 'Released', 'Completed']) };
});

// ---------- Outbound ----------
export type OrderStatus = 'Received' | 'Released' | 'Picked' | 'Packed' | 'Dispatched' | 'Backordered';
export interface Order { id: string; customer: string; wh: WhCode; date: string; promised: string; lines: number; units: number; unitsShipped: number; status: OrderStatus; cycleHrs: number | null; fillRate: number; otif: boolean | null; route: string }
export const ORDERS: Order[] = Array.from({ length: 240 }, (_, i) => {
  const date = ago(90);
  const r = rnd();
  const status: OrderStatus = r < 0.56 ? 'Dispatched' : r < 0.64 ? 'Packed' : r < 0.72 ? 'Picked' : r < 0.82 ? 'Released' : r < 0.92 ? 'Received' : 'Backordered';
  const units = int(6, 420);
  const unitsShipped = status === 'Dispatched' ? (rnd() < 0.86 ? units : Math.round(units * (0.7 + rnd() * 0.28))) : 0;
  return { id: `SO-${pad(240100 + i)}`, customer: pick(CUSTOMERS), wh: wh(), date, promised: plusH(date, int(24, 72)), lines: int(1, 34), units, unitsShipped, status, cycleHrs: status === 'Dispatched' ? Math.round((4 + rnd() * 40) * 10) / 10 : null, fillRate: status === 'Dispatched' ? Math.round((unitsShipped / units) * 1000) / 10 : 0, otif: status === 'Dispatched' ? rnd() < 0.9 && unitsShipped === units : null, route: pick(ROUTES) };
});

// ---------- Dispatch ----------
export interface Load { id: string; route: string; vehicle: string; carrier: string; wh: WhCode; date: string; cutoff: string; departed: string | null; orders: number; pallets: number; loadedPct: number; discrepancies: number; status: 'Departed' | 'Loading' | 'Planned' | 'Missed cut-off' }
export const LOADS: Load[] = Array.from({ length: 90 }, (_, i) => {
  const date = ago(90);
  const cutoff = plusH(date, int(4, 10));
  const r = rnd();
  const status: Load['status'] = r < 0.68 ? 'Departed' : r < 0.8 ? 'Missed cut-off' : r < 0.9 ? 'Loading' : 'Planned';
  const departed = status === 'Departed' ? plusH(cutoff, -rnd() * 1.5) : status === 'Missed cut-off' ? plusH(cutoff, 0.3 + rnd() * 3) : null;
  return { id: `LD-${pad(6600 + i)}`, route: pick(ROUTES), vehicle: `${pick(['KX', 'LN', 'BV', 'YR'])}${int(19, 74)} ${pick(['FHT', 'DWO', 'RNA', 'KLP', 'MZE'])}`, carrier: pick(CARRIERS), wh: wh(), date, cutoff, departed, orders: int(4, 38), pallets: int(6, 26), loadedPct: status === 'Planned' ? 0 : status === 'Loading' ? int(15, 92) : 100, discrepancies: rnd() < 0.15 ? int(1, 4) : 0, status };
});

// ---------- Stock counts ----------
export interface Count { id: string; plan: string; location: string; sku: string; name: string; category: string; wh: WhCode; date: string; system: number; counted: number; variance: number; varianceValue: number; reason: string; approval: 'Approved' | 'Pending' | 'Rejected' | 'No adjustment'; counter: string; repeat: boolean }
export const COUNTS: Count[] = Array.from({ length: 180 }, (_, i) => {
  const p = product();
  const system = int(0, 600);
  const varies = rnd() < 0.22;
  const counted = varies ? Math.max(0, system + int(-18, 12)) : system;
  const variance = counted - system;
  return { id: `CC-${pad(1400 + i)}`, plan: pick(['Weekly A-class', 'Monthly B-class', 'Quarterly C-class', 'Ad-hoc trigger']), location: loc(), sku: p.sku, name: p.name, category: p.category, wh: wh(), date: ago(90), system, counted, variance, varianceValue: Math.round(variance * p.unitCost * 100) / 100, reason: variance === 0 ? '—' : pick(['Damaged in storage', 'Mis-pick', 'Receiving error', 'Unrecorded move', 'Theft / shrinkage', 'Unit of measure error']), approval: variance === 0 ? 'No adjustment' : pick(['Approved', 'Approved', 'Pending', 'Rejected']), counter: pick(OPERATORS), repeat: varies && rnd() < 0.3 };
});

// ---------- Labour ----------
export type Role = 'Receiving' | 'Put-away' | 'Picking' | 'Packing' | 'Loading';
export interface Shift { id: string; operator: string; role: Role; wh: WhCode; date: string; hours: number; tasks: number; lines: number; units: number; idleMin: number }
const opRole = new Map(OPERATORS.map((o) => [o, pick(['Receiving', 'Put-away', 'Picking', 'Picking', 'Packing', 'Loading'] as Role[])]));
const opWh = new Map(OPERATORS.map((o) => [o, wh()]));
export const SHIFTS: Shift[] = Array.from({ length: 420 }, (_, i) => {
  const operator = pick(OPERATORS);
  const role = opRole.get(operator)!;
  const hours = pick([7.5, 8, 8, 10, 6]);
  const rate = { Receiving: 34, 'Put-away': 18, Picking: 96, Packing: 62, Loading: 22 }[role] * (0.7 + rnd() * 0.5);
  const lines = Math.round(rate * hours);
  return { id: `SH-${i}`, operator, role, wh: opWh.get(operator)!, date: ago(90), hours, tasks: Math.round(lines / (role === 'Picking' ? 1 : 3)), lines, units: Math.round(lines * (2 + rnd() * 6)), idleMin: int(4, 70) };
});
export const ROLE_TARGETS: Record<Role, number> = { Receiving: 34, 'Put-away': 18, Picking: 96, Packing: 62, Loading: 22 };

// ---------- Exceptions ----------
export type ExType = 'Overdue task' | 'Stock discrepancy' | 'Near-expiry stock' | 'Expired stock' | 'Blocked order' | 'Missed cut-off' | 'Failed transaction';
export interface Exception { id: string; type: ExType; severity: 'Critical' | 'High' | 'Medium' | 'Low'; ref: string; wh: WhCode; date: string; owner: string; status: 'Open' | 'Acknowledged' | 'Resolved'; detail: string }
const EX_DETAIL: Record<ExType, () => [string, string]> = {
  'Overdue task': () => [pick(PUTAWAY).id, `Put-away task open beyond 4h SLA at ${pick(['Dock 3', 'Dock 7', 'Dock 11'])}`],
  'Stock discrepancy': () => { const c = pick(COUNTS); return [c.id, `Count variance at ${c.location} on ${c.sku}`]; },
  'Near-expiry stock': () => { const st = pick(STOCK); return [st.batch, `${st.name} batch within 30 days of expiry`]; },
  'Expired stock': () => { const st = pick(STOCK); return [st.batch, `${st.name} batch past expiry, still pickable`]; },
  'Blocked order': () => [pick(ORDERS).id, pick(['Credit hold from customer account', 'Allocation failed: insufficient available stock', 'Address validation failed'])],
  'Missed cut-off': () => [pick(LOADS).id, 'Trailer departed after route cut-off'],
  'Failed transaction': () => [`TX-${pad(int(100000, 999999), 6)}`, pick(['Goods receipt posting rejected: unit of measure mismatch', 'Stock move rejected: location blocked', 'Despatch confirmation timed out'])],
};
export const EXCEPTIONS: Exception[] = Array.from({ length: 130 }, (_, i) => {
  const type = pick(Object.keys(EX_DETAIL) as ExType[]);
  const [ref, detail] = EX_DETAIL[type]();
  const r = rnd();
  return { id: `EX-${pad(8800 + i)}`, type, severity: r < 0.12 ? 'Critical' : r < 0.38 ? 'High' : r < 0.78 ? 'Medium' : 'Low', ref, wh: wh(), date: ago(60), owner: pick(OPERATORS), status: pick(['Open', 'Open', 'Acknowledged', 'Resolved']), detail };
});

// ---------- Traceability ----------
export type EventKind = 'Received' | 'Put away' | 'Replenished' | 'Picked' | 'Packed' | 'Dispatched' | 'Adjusted' | 'Counted';
export interface TraceEvent { at: string; kind: EventKind; qty: number; location: string; ref: string; operator: string; note?: string }
export interface Batch { batch: string; serial: string | null; sku: string; name: string; barcode: string; category: string; supplier: string; wh: WhCode; grn: string; po: string; expiry: string | null; receivedQty: number; events: TraceEvent[]; remaining: { location: string; qty: number; status: string }[]; orders: string[]; shipments: string[] }
export const BATCHES: Batch[] = Array.from({ length: 64 }, () => {
  const p = product();
  const rec = pick(RECEIPTS);
  const start = ago(120);
  const qty = int(120, 900);
  const bulk = loc(pick(['A', 'B', 'C']));
  const face = loc('P');
  const events: TraceEvent[] = [
    { at: start, kind: 'Received', qty, location: rec.dock, ref: rec.id, operator: pick(OPERATORS), note: `PO ${rec.po}` },
    { at: plusH(start, 1 + rnd() * 4), kind: 'Put away', qty, location: bulk, ref: `PA-${pad(int(30000, 31000))}`, operator: pick(OPERATORS) },
  ];
  let t = plusH(start, 8);
  let left = qty;
  const orders: string[] = [];
  const shipments: string[] = [];
  const steps = int(1, 4);
  for (let k = 0; k < steps && left > 20; k++) {
    const rq = Math.min(left, int(30, 220));
    events.push({ at: t, kind: 'Replenished', qty: rq, location: face, ref: `RP-${pad(int(5000, 5200))}`, operator: pick(OPERATORS), note: `From ${bulk}` });
    let faceLeft = rq;
    const nOrders = int(1, 3);
    for (let o = 0; o < nOrders && faceLeft > 0; o++) {
      t = plusH(t, 3 + rnd() * 30);
      const oq = Math.min(faceLeft, int(6, 90));
      const so = pick(ORDERS).id;
      const ld = pick(LOADS).id;
      events.push({ at: t, kind: 'Picked', qty: oq, location: face, ref: so, operator: pick(OPERATORS) });
      events.push({ at: plusH(t, 1), kind: 'Packed', qty: oq, location: `Pack bench ${int(1, 8)}`, ref: so, operator: pick(OPERATORS) });
      events.push({ at: plusH(t, 4 + rnd() * 6), kind: 'Dispatched', qty: oq, location: `Bay ${int(1, 14)}`, ref: ld, operator: pick(OPERATORS), note: `Order ${so}` });
      orders.push(so);
      shipments.push(ld);
      faceLeft -= oq;
      left -= oq;
    }
    t = plusH(t, 20 + rnd() * 60);
  }
  if (rnd() < 0.35) {
    const adj = -int(1, 6);
    events.push({ at: t, kind: 'Counted', qty: left + adj, location: bulk, ref: `CC-${pad(int(1400, 1580))}`, operator: pick(OPERATORS), note: `Variance ${adj}` });
    events.push({ at: plusH(t, 2), kind: 'Adjusted', qty: adj, location: bulk, ref: `ADJ-${pad(int(200, 900), 4)}`, operator: pick(OPERATORS), note: 'Damaged in storage' });
    left += adj;
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  const pickFaceQty = Math.min(left, int(0, 40));
  const remaining = [
    { location: bulk, qty: left - pickFaceQty, status: 'Available' },
    ...(pickFaceQty > 0 ? [{ location: face, qty: pickFaceQty, status: 'Pick face' }] : []),
  ].filter((r) => r.qty > 0);
  const perishable = ['Chilled', 'Ambient grocery', 'Beverages', 'Pet care'].includes(p.category);
  return { batch: `L${pad(int(2400, 2690), 4)}-${String.fromCharCode(65 + int(0, 7))}${int(10, 99)}`, serial: p.category === 'Hardware' ? `SN${pad(int(100000, 999999), 6)}` : null, sku: p.sku, name: p.name, barcode: p.barcode, category: p.category, supplier: p.supplier, wh: wh(), grn: rec.id, po: rec.po, expiry: perishable ? new Date(NOW + int(-10, 220) * 24 * HOUR).toISOString() : null, receivedQty: qty, events, remaining, orders: [...new Set(orders)], shipments: [...new Set(shipments)] };
});

export const NOW_MS = NOW;
