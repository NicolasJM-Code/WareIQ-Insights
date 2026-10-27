import { useEffect, useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { Search, PackageOpen, Warehouse, RefreshCcw, ScanLine, Package, Truck, ClipboardCheck, SlidersHorizontal, Download, ShieldAlert, X, Route as RouteIcon } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader, Panel, Pill } from '@/components/report-kit';
import { BATCHES, type Batch, type EventKind } from '@/lib/data';
import { useReport, useWarehouseScoped, useDocTitle } from '@/lib/report-context';
import { num, date, dateTime, daysUntil, downloadCsv } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type Field = 'all' | 'sku' | 'barcode' | 'batch' | 'serial' | 'expiry' | 'supplier' | 'receipt' | 'location' | 'order' | 'shipment';
const FIELDS: { v: Field; l: string }[] = [
  { v: 'all', l: 'Any reference' }, { v: 'sku', l: 'SKU / product' }, { v: 'barcode', l: 'Barcode' }, { v: 'batch', l: 'Batch / lot' }, { v: 'serial', l: 'Serial number' },
  { v: 'expiry', l: 'Expiry before (YYYY-MM-DD)' }, { v: 'supplier', l: 'Supplier' }, { v: 'receipt', l: 'Receipt (GRN / PO)' }, { v: 'location', l: 'Location' }, { v: 'order', l: 'Order' }, { v: 'shipment', l: 'Shipment / load' },
];
const fieldText: Record<Exclude<Field, 'all' | 'expiry'>, (b: Batch) => string> = {
  sku: (b) => `${b.sku} ${b.name}`,
  barcode: (b) => b.barcode,
  batch: (b) => b.batch,
  serial: (b) => b.serial ?? '',
  supplier: (b) => b.supplier,
  receipt: (b) => `${b.grn} ${b.po}`,
  location: (b) => b.events.map((e) => e.location).join(' ') + b.remaining.map((r) => r.location).join(' '),
  order: (b) => b.orders.join(' '),
  shipment: (b) => b.shipments.join(' '),
};
const ICON: Record<EventKind, typeof PackageOpen> = { Received: PackageOpen, 'Put away': Warehouse, Replenished: RefreshCcw, Picked: ScanLine, Packed: Package, Dispatched: Truck, Counted: ClipboardCheck, Adjusted: SlidersHorizontal };
const KIND_CLS: Record<EventKind, string> = { Received: 'bg-chart-1', 'Put away': 'bg-chart-1', Replenished: 'bg-chart-5', Picked: 'bg-chart-2', Packed: 'bg-chart-2', Dispatched: 'bg-chart-3', Counted: 'bg-muted-foreground', Adjusted: 'bg-chart-4' };

function matches(b: Batch, field: Field, q: string) {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  if (field === 'expiry') {
    const d = new Date(n);
    return !Number.isNaN(d.getTime()) && !!b.expiry && new Date(b.expiry) <= d;
  }
  if (field === 'all') return Object.values(fieldText).some((f) => f(b).toLowerCase().includes(n)) || (b.expiry ?? '').startsWith(n);
  return fieldText[field](b).toLowerCase().includes(n);
}

const remainingQty = (b: Batch) => b.remaining.reduce((a, r) => a + r.qty, 0);

export default function Traceability() {
  useDocTitle('Traceability');
  const search = useSearch();
  const { refreshing } = useReport();
  const scoped = useWarehouseScoped(BATCHES);
  const [field, setField] = useState<Field>('all');
  const [q, setQ] = useState(() => new URLSearchParams(search).get('q') ?? '');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(search).get('q');
    if (p) setQ(p);
  }, [search]);

  const results = useMemo(() => scoped.filter((b) => matches(b, field, q)), [scoped, field, q]);
  const current = results.find((b) => b.batch + b.sku === selected) ?? results[0] ?? null;
  const hasQuery = q.trim().length > 0;

  const impact = useMemo(() => ({
    batches: results.length,
    stock: results.reduce((a, b) => a + remainingQty(b), 0),
    locations: new Set(results.flatMap((b) => b.remaining.map((r) => `${b.wh} ${r.location}`))).size,
    orders: new Set(results.flatMap((b) => b.orders)).size,
    shipments: new Set(results.flatMap((b) => b.shipments)).size,
    dispatched: results.reduce((a, b) => a + b.events.filter((e) => e.kind === 'Dispatched').reduce((s, e) => s + e.qty, 0), 0),
  }), [results]);

  const exportAffected = () => {
    const rows = results.flatMap((b) => b.remaining.map((r) => ({ b, r })));
    downloadCsv('wareiq-trace-affected-stock', [
      { label: 'SKU', value: (x) => x.b.sku }, { label: 'Product', value: (x) => x.b.name }, { label: 'Batch', value: (x) => x.b.batch }, { label: 'Serial', value: (x) => x.b.serial },
      { label: 'Site', value: (x) => x.b.wh }, { label: 'Location', value: (x) => x.r.location }, { label: 'Qty', value: (x) => x.r.qty }, { label: 'Status', value: (x) => x.r.status },
      { label: 'Expiry', value: (x) => x.b.expiry?.slice(0, 10) }, { label: 'Supplier', value: (x) => x.b.supplier }, { label: 'GRN', value: (x) => x.b.grn },
    ], rows);
    toast({ title: 'Affected stock exported', description: `${rows.length} location lines across ${results.length} batches.` });
  };
  const exportTimeline = (b: Batch) => {
    downloadCsv(`wareiq-trace-${b.batch}`, [
      { label: 'Timestamp', value: (e) => e.at }, { label: 'Event', value: (e) => e.kind }, { label: 'Qty', value: (e) => e.qty }, { label: 'Location', value: (e) => e.location },
      { label: 'Reference', value: (e) => e.ref }, { label: 'Operator', value: (e) => e.operator }, { label: 'Note', value: (e) => e.note },
    ], b.events);
    toast({ title: 'Timeline exported', description: `${b.events.length} movements for batch ${b.batch}.` });
  };

  const examples = [BATCHES[0].batch, BATCHES[3].sku, BATCHES[5].supplier, BATCHES[2].orders[0], BATCHES[7].grn].filter(Boolean);

  return (
    <div>
      <PageHeader eyebrow="08 · Traceability" title="Follow a batch, end to end" description="Search any reference to see every movement from receipt to dispatch, where the remaining stock sits, and which orders and shipments a recall would touch. The site selector applies; the date range does not, because a batch's history is complete by design." />

      <section className="rise rounded-md border bg-card p-4 mb-4">
        <form onSubmit={(e) => e.preventDefault()} className="flex flex-col md:flex-row gap-2" role="search">
          <Select value={field} onValueChange={(v) => setField(v as Field)}>
            <SelectTrigger className="h-11 md:w-64" data-testid="select-trace-field" aria-label="Search field"><SelectValue /></SelectTrigger>
            <SelectContent>{FIELDS.map((f) => <SelectItem key={f.v} value={f.v}>{f.l}</SelectItem>)}</SelectContent>
          </Select>
          <label className="relative flex-1">
            <span className="sr-only">Trace reference</span>
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setSelected(null); }} data-testid="input-trace-search"
              placeholder={field === 'expiry' ? 'e.g. 2025-12-31' : 'SKU, barcode, batch, serial, supplier, GRN, location, order or load'}
              className="h-11 w-full rounded-md border bg-background pl-9 pr-9 font-mono text-[14px] outline-none focus:ring-2 focus:ring-ring/30 focus:border-primary/50" />
            {q && <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground" aria-label="Clear search" data-testid="button-clear-trace"><X className="h-4 w-4" /></button>}
          </label>
        </form>
        <div className="flex flex-wrap items-center gap-1.5 mt-3 text-[11px]">
          <span className="text-muted-foreground mr-1">Try</span>
          {examples.map((ex) => (
            <button key={ex} onClick={() => { setField('all'); setQ(ex); setSelected(null); }} className="font-mono rounded-sm border px-2 py-0.5 hover:border-primary/60 hover:bg-accent/40 transition-colors" data-testid={`button-example-${ex}`}>{ex}</button>
          ))}
        </div>
      </section>

      {hasQuery && (
        <section className={cn('rise rounded-md border mb-4 overflow-hidden', impact.batches ? 'border-[hsl(4_60%_80%)]' : '')} aria-label="Recall impact">
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-[hsl(4_75%_96%)] border-b border-[hsl(4_60%_86%)]">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            <h2 className="text-[13px] font-semibold">Recall impact for this search</h2>
            <button onClick={exportAffected} disabled={!impact.batches} className="ml-auto h-7 px-2.5 rounded bg-primary text-primary-foreground text-[12px] inline-flex items-center gap-1.5 disabled:opacity-50" data-testid="button-export-affected"><Download className="h-3.5 w-3.5" /> Affected stock CSV</button>
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 bg-card">
            {[['Batches', impact.batches], ['Units still in stock', impact.stock], ['Locations to quarantine', impact.locations], ['Units already shipped', impact.dispatched], ['Customer orders', impact.orders], ['Shipments / loads', impact.shipments]].map(([l, v]) => (
              <div key={l as string} className="px-4 py-3 border-r last:border-r-0 border-b lg:border-b-0">
                <dt className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{l}</dt>
                <dd className="font-display text-xl font-bold tnum" data-testid={`text-impact-${String(l).toLowerCase().replace(/\W+/g, '-')}`}>{num(v as number)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Panel title="Matching batches" meta={`${results.length} of ${scoped.length}`} className="lg:max-h-[760px] lg:overflow-y-auto">
          {results.length ? (
            <ul className="space-y-1.5 -mx-1">
              {results.map((b) => {
                const on = current && b.batch + b.sku === current.batch + current.sku;
                return (
                  <li key={b.batch + b.sku}>
                    <button onClick={() => setSelected(b.batch + b.sku)} aria-pressed={!!on} data-testid={`button-batch-${b.batch}`}
                      className={cn('w-full text-left rounded px-2.5 py-2 border transition-colors', on ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted')}>
                      <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] font-semibold">{b.batch}</span><span className="text-[11px] font-mono text-muted-foreground">{b.wh}</span><span className="ml-auto text-[11px] font-mono tnum">{num(remainingQty(b))} left</span></div>
                      <div className="text-[12px] text-muted-foreground truncate">{b.name} · {b.supplier}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="py-10 text-center">
              <RouteIcon className="h-8 w-8 mx-auto text-muted-foreground/50" />
              <p className="text-sm font-medium mt-2">No batch matches</p>
              <p className="text-[12px] text-muted-foreground">Check the search field type or switch site to All warehouses.</p>
            </div>
          )}
        </Panel>

        {current ? (
          <div className="space-y-4 min-w-0">
            <section className="rise rounded-md border bg-card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Batch</div>
                  <h2 className="font-display text-2xl font-bold" data-testid="text-trace-batch">{current.batch}</h2>
                  <p className="text-sm text-muted-foreground">{current.name} · <span className="font-mono">{current.sku}</span></p>
                </div>
                <button onClick={() => exportTimeline(current)} className="ml-auto h-8 px-3 rounded-md border bg-background text-[12px] inline-flex items-center gap-1.5 hover:border-primary/50" data-testid="button-export-timeline"><Download className="h-3.5 w-3.5" /> Timeline CSV</button>
              </div>
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 mt-4 text-[12.5px]">
                {[['Barcode', current.barcode], ['Serial', current.serial ?? 'Not serialised'], ['Supplier', current.supplier], ['Receipt', `${current.grn} / ${current.po}`], ['Site', current.wh], ['Received qty', num(current.receivedQty)], ['Expiry', current.expiry ? `${date(current.expiry)} (${daysUntil(current.expiry)}d)` : 'Non-perishable'], ['Category', current.category]].map(([k, v]) => (
                  <div key={k}><dt className="text-[10px] font-mono uppercase text-muted-foreground">{k}</dt><dd className="font-mono truncate">{v}</dd></div>
                ))}
              </dl>
            </section>

            <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
              <Panel title="Movement timeline" meta={`${current.events.length} movements`}>
                <ol className="relative ml-3 border-l-2 border-dashed border-border" data-testid="list-timeline">
                  {current.events.map((e, i) => {
                    const Icon = ICON[e.kind];
                    return (
                      <li key={i} className="relative pl-6 pb-4 last:pb-0 rise" style={{ animationDelay: `${i * 35}ms` }}>
                        <span className={cn('absolute -left-[13px] top-0 h-6 w-6 rounded-full grid place-items-center text-white ring-4 ring-card', KIND_CLS[e.kind])}><Icon className="h-3 w-3" /></span>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[13px] font-semibold">{e.kind}</span>
                          <span className={cn('font-mono text-[12px] tnum', e.qty < 0 && 'text-destructive')}>{num(e.qty)} units</span>
                          <span className="ml-auto text-[11px] font-mono text-muted-foreground">{dateTime(e.at)}</span>
                        </div>
                        <div className="text-[12px] text-muted-foreground">
                          <span className="font-mono text-foreground/80">{e.location}</span> · ref <span className="font-mono">{e.ref}</span> · {e.operator}{e.note && <> · {e.note}</>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Panel>
              <div className="space-y-4">
                <Panel title="Stock still on site">
                  {current.remaining.length ? (
                    <ul className="space-y-2 text-[12.5px]">
                      {current.remaining.map((r) => <li key={r.location} className="flex justify-between gap-2"><span className="font-mono">{r.location}</span><span className="flex items-center gap-2"><span className="font-mono tnum">{num(r.qty)}</span><Pill tone={r.status === 'Pick face' ? 'warn' : 'info'}>{r.status}</Pill></span></li>)}
                    </ul>
                  ) : <p className="text-[12px] text-muted-foreground">Fully consumed. Nothing left to quarantine.</p>}
                </Panel>
                <Panel title="Downstream orders">
                  {current.orders.length ? <div className="flex flex-wrap gap-1.5">{current.orders.map((o) => <button key={o} onClick={() => { setField('order'); setQ(o); setSelected(null); }} className="font-mono text-[11.5px] rounded-sm border px-1.5 py-0.5 hover:border-primary/60" data-testid={`button-trace-order-${o}`}>{o}</button>)}</div> : <p className="text-[12px] text-muted-foreground">Not yet picked to any order.</p>}
                </Panel>
                <Panel title="Shipments / loads">
                  {current.shipments.length ? <div className="flex flex-wrap gap-1.5">{current.shipments.map((s) => <button key={s} onClick={() => { setField('shipment'); setQ(s); setSelected(null); }} className="font-mono text-[11.5px] rounded-sm border px-1.5 py-0.5 hover:border-primary/60" data-testid={`button-trace-load-${s}`}>{s}</button>)}</div> : <p className="text-[12px] text-muted-foreground">Not dispatched yet.</p>}
                </Panel>
              </div>
            </div>
            {refreshing && <p className="text-[11px] font-mono text-muted-foreground">Re-reading sample data…</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
