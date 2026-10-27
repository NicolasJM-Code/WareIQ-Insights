import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, Meter, type Tone } from '@/components/report-kit';
import { PUTAWAY, LOCATIONS, type PutawayTask, type Location } from '@/lib/data';
import { useScoped, useWarehouseScoped, useDocTitle } from '@/lib/report-context';
import { num, pct, dateTime, mins } from '@/lib/format';

const tone: Record<PutawayTask['status'], Tone> = { Completed: 'good', 'In progress': 'info', Pending: 'warn' };

export default function Putaway() {
  useDocTitle('Put-away & locations');
  const tasks = useScoped(PUTAWAY);
  const locs = useWarehouseScoped(LOCATIONS);
  const done = tasks.filter((t) => t.status === 'Completed');
  const avg = done.length ? done.reduce((a, t) => a + (t.minutes ?? 0), 0) / done.length : null;
  const cap = locs.reduce((a, l) => a + l.capacity, 0);
  const used = locs.reduce((a, l) => a + l.used, 0);
  const blocked = locs.filter((l) => l.blocked);
  const zones = Object.entries(locs.reduce<Record<string, { c: number; u: number }>>((a, l) => { a[l.zone] ??= { c: 0, u: 0 }; a[l.zone].c += l.capacity; a[l.zone].u += l.used; return a; }, {}))
    .sort().map(([z, v]) => ({ label: `Zone ${z}${z === 'P' ? ' (pick faces)' : ''}`, value: Math.round((v.u / v.c) * 1000) / 10 }));

  return (
    <div>
      <PageHeader eyebrow="03 · Put-away" title="Put-away & locations" description="Received stock moving from dock to rack, and how much room the racking has left." />
      <KpiGrid>
        <Kpi label="Put-away completion" value={pct(tasks.length ? (done.length / tasks.length) * 100 : NaN)} sub={`${num(done.length)} of ${num(tasks.length)} tasks`} tone="good" />
        <Kpi label="Avg time to put away" value={mins(avg)} sub="dock scan to location scan" tone="info" />
        <Kpi label="Pending tasks" value={num(tasks.length - done.length)} tone={tasks.length - done.length > 20 ? 'warn' : 'good'} />
        <Kpi label="Location utilisation" value={pct(cap ? (used / cap) * 100 : NaN)} sub={`${num(cap - used)} units free`} tone={used / cap > 0.88 ? 'bad' : 'good'} />
        <Kpi label="Blocked locations" value={num(blocked.length)} sub={`of ${locs.length} tracked`} tone={blocked.length ? 'warn' : 'good'} />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <Panel title="Utilisation by zone" meta="% capacity used"><BarList items={zones} format={(n) => `${n}%`} tone="bg-chart-2" /></Panel>
        <Panel title="Blocked locations" meta={`${blocked.length} currently blocked`}>
          {blocked.length ? (
            <ul className="grid sm:grid-cols-2 gap-2">
              {blocked.map((b) => (
                <li key={b.code + b.wh} className="rounded border border-dashed px-2.5 py-1.5 text-[12px] flex justify-between gap-2">
                  <span className="font-mono">{b.wh} {b.code}</span><span className="text-muted-foreground truncate">{b.blockReason}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground py-6 text-center">No blocked locations.</p>}
        </Panel>
      </div>
      <Tabs defaultValue="tasks">
        <TabsList className="mb-3"><TabsTrigger value="tasks" data-testid="tab-tasks">Put-away tasks</TabsTrigger><TabsTrigger value="locations" data-testid="tab-locations">Locations & capacity</TabsTrigger></TabsList>
        <TabsContent value="tasks">
          <DataReport<PutawayTask>
            title="Put-away tasks" filename="wareiq-putaway-tasks" rows={tasks} rowKey={(r) => r.id}
            searchText={(r) => `${r.id} ${r.grn} ${r.sku} ${r.name} ${r.to} ${r.operator}`}
            facets={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'wh', label: 'Site', value: (r) => r.wh }]}
            columns={[
              { key: 'id', label: 'Task', value: (r) => r.id, className: 'font-mono' },
              { key: 'grn', label: 'GRN', value: (r) => r.grn, className: 'font-mono text-muted-foreground' },
              { key: 'sku', label: 'SKU', value: (r) => r.sku, className: 'font-mono' },
              { key: 'name', label: 'Product', value: (r) => r.name },
              { key: 'qty', label: 'Qty', value: (r) => r.qty, align: 'right' },
              { key: 'to', label: 'To location', value: (r) => r.to, className: 'font-mono' },
              { key: 'date', label: 'Created', value: (r) => r.date, render: (r) => dateTime(r.date) },
              { key: 'min', label: 'Duration', value: (r) => r.minutes, align: 'right', render: (r) => mins(r.minutes) },
              { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={tone[r.status]}>{r.status}</Pill> },
            ]}
            detail={(r) => ({ title: r.id, subtitle: `${r.name} · ${r.sku}`, body: <DetailList items={[['Site', r.wh], ['From receipt', r.grn], ['From', r.from], ['To', r.to], ['Quantity', r.qty], ['Operator', r.operator], ['Created', dateTime(r.date)], ['Duration', mins(r.minutes)], ['Status', r.status]]} /> })}
          />
        </TabsContent>
        <TabsContent value="locations">
          <DataReport<Location>
            title="Storage locations" filename="wareiq-locations-capacity" rows={locs} rowKey={(r) => r.wh + r.code}
            searchText={(r) => `${r.code} ${r.type} ${r.blockReason}`}
            facets={[{ key: 'zone', label: 'Zone', value: (r) => r.zone }, { key: 'type', label: 'Type', value: (r) => r.type }, { key: 'blocked', label: 'Availability', value: (r) => (r.blocked ? 'Blocked' : 'Open') }]}
            columns={[
              { key: 'code', label: 'Location', value: (r) => r.code, className: 'font-mono' },
              { key: 'wh', label: 'Site', value: (r) => r.wh },
              { key: 'type', label: 'Type', value: (r) => r.type },
              { key: 'cap', label: 'Capacity', value: (r) => r.capacity, align: 'right' },
              { key: 'used', label: 'Used', value: (r) => r.used, align: 'right' },
              { key: 'util', label: 'Utilisation', value: (r) => r.used / r.capacity, render: (r) => <Meter value={(r.used / r.capacity) * 100} /> },
              { key: 'blocked', label: 'Block', value: (r) => r.blockReason, render: (r) => (r.blocked ? <Pill tone="bad">{r.blockReason}</Pill> : <span className="text-muted-foreground">—</span>) },
            ]}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
