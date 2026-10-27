import { useMemo } from 'react';
import { Link } from 'wouter';
import { ArrowRight, PackageOpen, Warehouse, Boxes, ScanLine, ClipboardList, Truck } from 'lucide-react';
import { PageHeader, Kpi, KpiGrid, Panel, Columns, BarList, Pill, Meter, type Tone } from '@/components/report-kit';
import { RECEIPTS, PUTAWAY, STOCK, PICKS, ORDERS, LOADS, COUNTS, EXCEPTIONS, SHIFTS, WAREHOUSES } from '@/lib/data';
import { useReport, useScoped, useWarehouseScoped, useDocTitle } from '@/lib/report-context';
import { bucket, num, pct, dateTime, dec } from '@/lib/format';
import { cn } from '@/lib/utils';

const sevTone: Record<string, Tone> = { Critical: 'bad', High: 'warn', Medium: 'info', Low: 'neutral' };

export default function Dashboard() {
  useDocTitle('Executive dashboard');
  const { range, prefs, warehouse } = useReport();
  const receipts = useScoped(RECEIPTS);
  const putaway = useScoped(PUTAWAY);
  const picks = useScoped(PICKS);
  const orders = useScoped(ORDERS);
  const loads = useScoped(LOADS);
  const counts = useScoped(COUNTS);
  const exceptions = useScoped(EXCEPTIONS);
  const shifts = useScoped(SHIFTS);
  const stock = useWarehouseScoped(STOCK);

  const k = useMemo(() => {
    const dispatched = orders.filter((o) => o.status === 'Dispatched');
    const units = dispatched.reduce((a, o) => a + o.units, 0);
    const shipped = dispatched.reduce((a, o) => a + o.unitsShipped, 0);
    const otifBase = dispatched.filter((o) => o.otif !== null);
    const accurate = counts.filter((c) => c.variance === 0).length;
    const pickDone = picks.filter((p) => p.status !== 'Outstanding');
    const pickOk = pickDone.filter((p) => p.status === 'Picked').length;
    const pickHours = shifts.filter((s) => s.role === 'Picking').reduce((a, s) => a + s.hours, 0);
    const pickLines = shifts.filter((s) => s.role === 'Picking').reduce((a, s) => a + s.lines, 0);
    const d2s = receipts.filter((r) => r.dockToStockMin != null);
    return {
      processed: dispatched.length,
      fill: units ? (shipped / units) * 100 : NaN,
      otif: otifBase.length ? (otifBase.filter((o) => o.otif).length / otifBase.length) * 100 : NaN,
      accuracy: counts.length ? (accurate / counts.length) * 100 : NaN,
      pickAcc: pickDone.length ? (pickOk / pickDone.length) * 100 : NaN,
      lph: pickHours ? pickLines / pickHours : 0,
      inUnits: receipts.reduce((a, r) => a + r.received, 0),
      outUnits: shipped,
      d2s: d2s.length ? d2s.reduce((a, r) => a + (r.dockToStockMin ?? 0), 0) / d2s.length : NaN,
      open: exceptions.filter((e) => e.status !== 'Resolved').length,
      critical: exceptions.filter((e) => e.status !== 'Resolved' && e.severity === 'Critical').length,
    };
  }, [orders, counts, picks, shifts, receipts, exceptions]);

  const flow = [
    { label: 'Received', icon: PackageOpen, href: '/inbound', value: receipts.filter((r) => r.status !== 'Outstanding').length, unit: 'receipts', wait: receipts.filter((r) => r.status === 'Outstanding').length, waitLabel: 'outstanding' },
    { label: 'Put away', icon: Warehouse, href: '/putaway', value: putaway.filter((p) => p.status === 'Completed').length, unit: 'tasks', wait: putaway.filter((p) => p.status !== 'Completed').length, waitLabel: 'pending' },
    { label: 'In stock', icon: Boxes, href: '/inventory', value: stock.reduce((a, s) => a + Math.max(0, s.onHand), 0), unit: 'units', wait: stock.filter((s) => s.status !== 'OK').length, waitLabel: 'flagged lines' },
    { label: 'Picked', icon: ScanLine, href: '/picking', value: picks.filter((p) => p.status !== 'Outstanding').length, unit: 'pick lines', wait: picks.filter((p) => p.status === 'Short pick').length, waitLabel: 'short' },
    { label: 'Packed', icon: ClipboardList, href: '/outbound', value: orders.filter((o) => ['Packed', 'Dispatched'].includes(o.status)).length, unit: 'orders', wait: orders.filter((o) => o.status === 'Backordered').length, waitLabel: 'backordered' },
    { label: 'Dispatched', icon: Truck, href: '/dispatch', value: loads.filter((l) => l.status === 'Departed' || l.status === 'Missed cut-off').length, unit: 'loads', wait: loads.filter((l) => l.status === 'Missed cut-off').length, waitLabel: 'missed cut-off' },
  ];

  const trend = [
    { name: 'Inbound units', cls: 'bg-chart-1', data: bucket(receipts, range, (r) => r.received) },
    { name: 'Outbound units', cls: 'bg-chart-2', data: bucket(orders.filter((o) => o.status === 'Dispatched'), range, (o) => o.unitsShipped) },
  ];

  const exByType = Object.entries(exceptions.filter((e) => e.status !== 'Resolved').reduce<Record<string, number>>((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}))
    .map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  const topEx = exceptions.filter((e) => e.status === 'Open').sort((a, b) => ['Critical', 'High', 'Medium', 'Low'].indexOf(a.severity) - ['Critical', 'High', 'Medium', 'Low'].indexOf(b.severity) || b.date.localeCompare(a.date)).slice(0, 6);

  const sites = WAREHOUSES.map((w) => {
    const o = orders.filter((x) => x.wh === w.code);
    const d = o.filter((x) => x.status === 'Dispatched');
    const u = d.reduce((a, x) => a + x.units, 0);
    const sh = d.reduce((a, x) => a + x.unitsShipped, 0);
    const c = counts.filter((x) => x.wh === w.code);
    const ex = exceptions.filter((x) => x.wh === w.code && x.status !== 'Resolved').length;
    return { ...w, orders: d.length, fill: u ? (sh / u) * 100 : NaN, acc: c.length ? (c.filter((x) => x.variance === 0).length / c.length) * 100 : NaN, ex, inScope: warehouse === 'ALL' || warehouse === w.code };
  });

  const rangeLabel = range === 1 ? 'last 24 hours' : `last ${range} days`;

  return (
    <div>
      <PageHeader eyebrow="Executive dashboard" title="Warehouse pulse" description={`Throughput, accuracy and exceptions across ${warehouse === 'ALL' ? 'all three sites' : WAREHOUSES.find((w) => w.code === warehouse)?.name} for the ${rangeLabel}.`} />

      <KpiGrid>
        <Kpi testId="kpi-orders" label="Orders dispatched" value={num(k.processed)} sub={`${num(k.outUnits)} units out`} tone="info" />
        <Kpi testId="kpi-fill" label="Fill rate" value={pct(k.fill)} target={`${prefs.targetFillRate}%`} tone={k.fill >= prefs.targetFillRate ? 'good' : 'warn'} sub={`OTIF ${pct(k.otif)}`} />
        <Kpi testId="kpi-accuracy" label="Inventory accuracy" value={pct(k.accuracy)} sub={`${counts.length} counts`} tone={k.accuracy >= 85 ? 'good' : 'warn'} />
        <Kpi testId="kpi-pick" label="Pick accuracy" value={pct(k.pickAcc, 2)} target={`${prefs.targetPickAccuracy}%`} tone={k.pickAcc >= prefs.targetPickAccuracy ? 'good' : 'bad'} sub={`${dec(k.lph)} lines/hr`} />
        <Kpi testId="kpi-exceptions" label="Open exceptions" value={num(k.open)} sub={`${k.critical} critical`} tone={k.critical ? 'bad' : 'good'} />
      </KpiGrid>

      {/* Flow line: the signature view — stock path from dock to trailer */}
      <section className="rise mb-5 rounded-md border bg-card overflow-hidden" aria-label="Stock flow">
        <div className="flex items-center justify-between px-4 pt-3.5">
          <h2 className="text-[13px] font-semibold">Stock flow, dock to trailer</h2>
          <span className="text-[11px] font-mono text-muted-foreground">Avg dock-to-stock {Number.isFinite(k.d2s) ? `${Math.round(k.d2s)} min` : '—'} · target {prefs.targetDockToStockMin} min</span>
        </div>
        <ol className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 p-3 gap-2">
          {flow.map((f, i) => {
            const Icon = f.icon;
            return (
              <li key={f.label} className="relative">
                <Link href={f.href} data-testid={`link-flow-${f.label.toLowerCase().replace(' ', '-')}`} className="group block h-full rounded border bg-background/60 p-3 hover:border-primary/60 hover:-translate-y-0.5 transition-all">
                  <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    <span className="grid place-items-center h-5 w-5 rounded-sm bg-primary text-primary-foreground text-[10px]">{i + 1}</span>
                    {f.label}
                    <ArrowRight className="h-3 w-3 ml-auto opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition" />
                  </div>
                  <div className="flex items-end gap-2 mt-2">
                    <Icon className="h-5 w-5 text-primary/70 mb-1" />
                    <span className="font-display text-2xl font-bold tnum">{num(f.value)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{f.unit}</div>
                  <div className={cn('mt-2 text-[11px] font-medium', f.wait ? 'text-[hsl(30_75%_32%)]' : 'text-muted-foreground')}>{num(f.wait)} {f.waitLabel}</div>
                </Link>
              </li>
            );
          })}
        </ol>
        <div className="h-1.5 hazard opacity-70" />
      </section>

      <div className="grid gap-4 xl:grid-cols-3 mb-4">
        <Panel title="Inbound vs outbound units" meta={rangeLabel} className="xl:col-span-2">
          <Columns series={trend} height={180} format={num} />
        </Panel>
        <Panel title="Open exceptions by type" action={<Link href="/exceptions" className="text-[12px] text-primary hover:underline" data-testid="link-all-exceptions">View all</Link>}>
          <BarList items={exByType} tone="bg-chart-4" />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Panel title="Needs attention now" meta={`${topEx.length} highest-severity open`} className="xl:col-span-3">
          {topEx.length ? (
            <ul className="divide-y -mx-1">
              {topEx.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-1 py-2.5" data-testid={`item-exception-${e.id}`}>
                  <Pill tone={sevTone[e.severity]}>{e.severity}</Pill>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{e.type} <span className="font-mono text-muted-foreground font-normal">{e.ref}</span></div>
                    <div className="text-[12px] text-muted-foreground truncate">{e.detail}</div>
                  </div>
                  <div className="text-right text-[11px] font-mono text-muted-foreground shrink-0">{e.wh}<br />{dateTime(e.date)}</div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground py-6 text-center">No open exceptions in this scope.</p>}
        </Panel>
        <Panel title="Site comparison" meta={rangeLabel} className="xl:col-span-2">
          <table className="w-full text-[12.5px]">
            <thead className="text-[11px] uppercase text-muted-foreground"><tr><th className="text-left font-medium py-1">Site</th><th className="text-right font-medium">Orders</th><th className="font-medium text-left pl-3">Fill</th><th className="text-right font-medium">Exc.</th></tr></thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.code} className={cn('border-t', !s.inScope && 'opacity-40')}>
                  <td className="py-2"><span className="font-mono font-semibold">{s.code}</span> <span className="text-muted-foreground">{s.name}</span></td>
                  <td className="text-right font-mono tnum">{num(s.orders)}</td>
                  <td className="pl-3 w-28"><Meter value={Number.isFinite(s.fill) ? s.fill : 0} tone={s.fill >= prefs.targetFillRate ? 'good' : 'warn'} /></td>
                  <td className="text-right font-mono tnum">{s.ex}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-muted-foreground mt-3">Inventory accuracy: {sites.map((s) => `${s.code} ${pct(s.acc)}`).join(' · ')}</p>
        </Panel>
      </div>
    </div>
  );
}
