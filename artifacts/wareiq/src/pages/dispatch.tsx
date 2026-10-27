import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, Meter, type Tone } from '@/components/report-kit';
import { LOADS, type Load } from '@/lib/data';
import { useScoped, useDocTitle } from '@/lib/report-context';
import { num, pct, dateTime } from '@/lib/format';

const tone: Record<Load['status'], Tone> = { Departed: 'good', Loading: 'info', Planned: 'neutral', 'Missed cut-off': 'bad' };
const lateMin = (l: Load) => (l.departed ? Math.round((new Date(l.departed).getTime() - new Date(l.cutoff).getTime()) / 60000) : null);

export default function Dispatch() {
  useDocTitle('Loading & dispatch');
  const rows = useScoped(LOADS);
  const gone = rows.filter((l) => l.departed);
  const onTime = gone.filter((l) => l.status === 'Departed');
  const comp = gone.length ? (onTime.length / gone.length) * 100 : NaN;
  const disc = rows.filter((l) => l.discrepancies > 0);
  const byRoute = Object.entries(rows.reduce<Record<string, number>>((a, l) => ((a[l.route] = (a[l.route] ?? 0) + l.orders), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const missedByRoute = Object.entries(rows.filter((l) => l.status === 'Missed cut-off').reduce<Record<string, number>>((a, l) => ((a[l.route] = (a[l.route] ?? 0) + 1), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const active = rows.filter((l) => l.status === 'Loading' || l.status === 'Planned');

  return (
    <div>
      <PageHeader eyebrow="07 · Dispatch" title="Loading & dispatch" description="Trailers by route and vehicle: how full, how accurate, and whether they left before cut-off." />
      <KpiGrid>
        <Kpi label="Loads" value={num(rows.length)} sub={`${num(gone.length)} departed`} tone="info" />
        <Kpi label="Orders dispatched" value={num(gone.reduce((a, l) => a + l.orders, 0))} sub={`${num(gone.reduce((a, l) => a + l.pallets, 0))} pallets`} tone="neutral" />
        <Kpi label="Cut-off compliance" value={pct(comp)} sub={`${gone.length - onTime.length} late departures`} tone={comp > 85 ? 'good' : 'bad'} />
        <Kpi label="Shipment discrepancies" value={num(disc.reduce((a, l) => a + l.discrepancies, 0))} sub={`on ${disc.length} loads`} tone={disc.length ? 'warn' : 'good'} />
        <Kpi label="On the dock" value={num(active.length)} sub="loading or planned" tone="info" />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Panel title="Loads in progress" meta="loading completion">
          {active.length ? (
            <ul className="space-y-2.5">
              {active.slice(0, 7).map((l) => (
                <li key={l.id} className="text-[12px]"><div className="flex justify-between mb-1"><span className="font-mono">{l.id} · {l.vehicle}</span><span className="text-muted-foreground">cut-off {dateTime(l.cutoff)}</span></div><Meter value={l.loadedPct} tone="info" /></li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground py-6 text-center">Nothing on the dock in this range.</p>}
        </Panel>
        <Panel title="Orders by route"><BarList items={byRoute} format={num} /></Panel>
        <Panel title="Missed cut-offs by route"><BarList items={missedByRoute} format={num} tone="bg-chart-4" /></Panel>
      </div>
      <DataReport<Load>
        title="Loads" filename="wareiq-loads-dispatch" rows={rows} rowKey={(r) => r.id}
        searchText={(r) => `${r.id} ${r.route} ${r.vehicle} ${r.carrier}`}
        facets={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'route', label: 'Route', value: (r) => r.route }, { key: 'carrier', label: 'Carrier', value: (r) => r.carrier }]}
        columns={[
          { key: 'id', label: 'Load', value: (r) => r.id, className: 'font-mono' },
          { key: 'route', label: 'Route', value: (r) => r.route },
          { key: 'vehicle', label: 'Vehicle', value: (r) => r.vehicle, className: 'font-mono' },
          { key: 'carrier', label: 'Carrier', value: (r) => r.carrier },
          { key: 'orders', label: 'Orders', value: (r) => r.orders, align: 'right' },
          { key: 'loaded', label: 'Loaded', value: (r) => r.loadedPct, render: (r) => <Meter value={r.loadedPct} tone={r.loadedPct === 100 ? 'good' : 'info'} /> },
          { key: 'cutoff', label: 'Cut-off', value: (r) => r.cutoff, render: (r) => dateTime(r.cutoff) },
          { key: 'departed', label: 'Departed', value: (r) => r.departed, render: (r) => dateTime(r.departed) },
          { key: 'late', label: 'vs cut-off', value: lateMin, align: 'right', render: (r) => { const m = lateMin(r); return m == null ? '—' : <span className={m > 0 ? 'text-destructive' : ''}>{m > 0 ? `+${m}` : m}m</span>; } },
          { key: 'disc', label: 'Disc.', value: (r) => r.discrepancies, align: 'right' },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={tone[r.status]}>{r.status}</Pill> },
        ]}
        detail={(r) => ({ title: r.id, subtitle: `${r.route} · ${r.vehicle}`, body: <DetailList items={[['Site', r.wh], ['Carrier', r.carrier], ['Orders', r.orders], ['Pallets', r.pallets], ['Loaded', `${r.loadedPct}%`], ['Cut-off', dateTime(r.cutoff)], ['Departed', dateTime(r.departed)], ['Discrepancies', r.discrepancies], ['Status', r.status]]} /> })}
      />
    </div>
  );
}
