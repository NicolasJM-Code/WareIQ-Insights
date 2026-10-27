import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, type Tone } from '@/components/report-kit';
import { ORDERS, type Order, type OrderStatus } from '@/lib/data';
import { useReport, useScoped, useDocTitle } from '@/lib/report-context';
import { num, pct, dec, dateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const STAGES: OrderStatus[] = ['Received', 'Released', 'Picked', 'Packed', 'Dispatched'];
const tone: Record<OrderStatus, Tone> = { Received: 'neutral', Released: 'info', Picked: 'info', Packed: 'warn', Dispatched: 'good', Backordered: 'bad' };

export default function Outbound() {
  useDocTitle('Order fulfilment');
  const { prefs } = useReport();
  const rows = useScoped(ORDERS);
  const d = rows.filter((o) => o.status === 'Dispatched');
  const units = d.reduce((a, o) => a + o.units, 0);
  const shipped = d.reduce((a, o) => a + o.unitsShipped, 0);
  const fill = units ? (shipped / units) * 100 : NaN;
  const otif = d.length ? (d.filter((o) => o.otif).length / d.length) * 100 : NaN;
  const cycle = d.length ? d.reduce((a, o) => a + (o.cycleHrs ?? 0), 0) / d.length : NaN;
  const back = rows.filter((o) => o.status === 'Backordered');
  const incomplete = d.filter((o) => o.unitsShipped < o.units);
  const reached = (s: OrderStatus) => rows.filter((o) => STAGES.indexOf(o.status) >= STAGES.indexOf(s)).length;
  const funnelMax = Math.max(1, rows.length);
  const byCust = Object.entries(d.reduce<Record<string, { u: number; s: number }>>((a, o) => { a[o.customer] ??= { u: 0, s: 0 }; a[o.customer].u += o.units; a[o.customer].s += o.unitsShipped; return a; }, {})).map(([label, v]) => ({ label, value: Math.round((v.s / v.u) * 1000) / 10 })).sort((a, b) => a.value - b.value);

  return (
    <div>
      <PageHeader eyebrow="06 · Outbound" title="Order fulfilment" description="Customer orders from release to dispatch: where they are stuck, how complete they leave, and whether they arrive on time." />
      <KpiGrid>
        <Kpi label="Orders received" value={num(rows.length)} sub={`${num(d.length)} dispatched`} tone="info" />
        <Kpi label="Fill rate" value={pct(fill)} target={`${prefs.targetFillRate}%`} tone={fill >= prefs.targetFillRate ? 'good' : 'warn'} />
        <Kpi label="OTIF" value={pct(otif)} sub="where delivery data exists" tone={otif > 88 ? 'good' : 'warn'} />
        <Kpi label="Order cycle time" value={`${dec(cycle)}h`} sub="received to dispatched" tone="neutral" />
        <Kpi label="Backorders" value={num(back.length)} sub={`${incomplete.length} shipped incomplete`} tone={back.length ? 'bad' : 'good'} />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-5 mb-4">
        <Panel title="Fulfilment funnel" meta="orders reaching each stage" className="lg:col-span-3">
          <ol className="space-y-2">
            {STAGES.map((s, i) => {
              const v = reached(s);
              return (
                <li key={s} className="grid grid-cols-[90px_1fr_60px] items-center gap-3 text-[12.5px]">
                  <span className="text-muted-foreground">{s}</span>
                  <div className="h-6 bg-muted rounded-sm overflow-hidden">
                    <div className={cn('h-full grow-x rounded-sm', i === STAGES.length - 1 ? 'bg-chart-3' : 'bg-chart-1')} style={{ width: `${(v / funnelMax) * 100}%`, opacity: 1 - i * 0.1, animationDelay: `${i * 70}ms` }} />
                  </div>
                  <span className="font-mono tnum text-right">{num(v)}</span>
                </li>
              );
            })}
          </ol>
        </Panel>
        <Panel title="Fill rate by customer" meta="lowest first" className="lg:col-span-2"><BarList items={byCust} format={(n) => `${n}%`} tone="bg-chart-2" /></Panel>
      </div>
      <DataReport<Order>
        title="Customer orders" filename="wareiq-order-fulfilment" rows={rows} rowKey={(r) => r.id}
        searchText={(r) => `${r.id} ${r.customer} ${r.route}`}
        facets={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'customer', label: 'Customer', value: (r) => r.customer }, { key: 'wh', label: 'Site', value: (r) => r.wh }]}
        columns={[
          { key: 'id', label: 'Order', value: (r) => r.id, className: 'font-mono' },
          { key: 'customer', label: 'Customer', value: (r) => r.customer },
          { key: 'wh', label: 'Site', value: (r) => r.wh },
          { key: 'date', label: 'Received', value: (r) => r.date, render: (r) => dateTime(r.date) },
          { key: 'lines', label: 'Lines', value: (r) => r.lines, align: 'right' },
          { key: 'units', label: 'Units', value: (r) => r.units, align: 'right' },
          { key: 'fill', label: 'Fill %', value: (r) => (r.status === 'Dispatched' ? r.fillRate : null), align: 'right', render: (r) => (r.status === 'Dispatched' ? `${r.fillRate}%` : '—') },
          { key: 'cycle', label: 'Cycle h', value: (r) => r.cycleHrs, align: 'right', render: (r) => (r.cycleHrs ?? '—') },
          { key: 'otif', label: 'OTIF', value: (r) => (r.otif == null ? null : r.otif ? 'Yes' : 'No'), render: (r) => (r.otif == null ? '—' : <Pill tone={r.otif ? 'good' : 'bad'}>{r.otif ? 'Yes' : 'No'}</Pill>) },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={tone[r.status]}>{r.status}</Pill> },
        ]}
        detail={(r) => ({ title: r.id, subtitle: r.customer, body: <DetailList items={[['Site', r.wh], ['Route', r.route], ['Received', dateTime(r.date)], ['Promised', dateTime(r.promised)], ['Lines', r.lines], ['Units ordered', num(r.units)], ['Units shipped', num(r.unitsShipped)], ['Cycle time', r.cycleHrs ? `${r.cycleHrs}h` : '—'], ['Status', r.status]]} /> })}
      />
    </div>
  );
}
