import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader, Kpi, KpiGrid, Panel, BarList, Columns, DataReport, DetailList, Pill, Meter, type Tone } from '@/components/report-kit';
import { PICKS, REPLEN, SHIFTS, type Pick, type Replen } from '@/lib/data';
import { useReport, useScoped, useDocTitle } from '@/lib/report-context';
import { bucket, num, pct, dec, dateTime } from '@/lib/format';

const pTone: Record<Pick['status'], Tone> = { Picked: 'good', 'Short pick': 'bad', 'Mis-pick corrected': 'warn', Outstanding: 'info' };
const rTone: Record<Replen['priority'], Tone> = { Urgent: 'bad', High: 'warn', Normal: 'neutral' };

export default function Picking() {
  useDocTitle('Replenishment & picking');
  const { range, prefs } = useReport();
  const picks = useScoped(PICKS);
  const replen = useScoped(REPLEN);
  const shifts = useScoped(SHIFTS).filter((s) => s.role === 'Picking');
  const done = picks.filter((p) => p.status !== 'Outstanding');
  const acc = done.length ? (done.filter((p) => p.status === 'Picked').length / done.length) * 100 : NaN;
  const hrs = shifts.reduce((a, s) => a + s.hours, 0);
  const lph = hrs ? shifts.reduce((a, s) => a + s.lines, 0) / hrs : 0;
  const shorts = picks.filter((p) => p.status === 'Short pick');
  const openRep = replen.filter((r) => r.status !== 'Completed');
  const faceAvail = replen.length ? (replen.filter((r) => r.current >= r.min).length / replen.length) * 100 : NaN;
  const shortBySku = Object.entries(shorts.reduce<Record<string, number>>((a, p) => ((a[p.name] = (a[p.name] ?? 0) + p.short), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 7);

  return (
    <div>
      <PageHeader eyebrow="05 · Picking" title="Replenishment & picking" description="Whether pick faces are stocked ahead of demand, and how accurately and quickly orders are being picked." />
      <KpiGrid>
        <Kpi label="Picking accuracy" value={pct(acc, 2)} target={`${prefs.targetPickAccuracy}%`} tone={acc >= prefs.targetPickAccuracy ? 'good' : 'bad'} />
        <Kpi label="Lines per hour" value={dec(lph)} sub={`${dec(hrs, 0)} picker hours`} tone="info" />
        <Kpi label="Short picks" value={num(shorts.length)} sub={`${num(shorts.reduce((a, p) => a + p.short, 0))} units short`} tone={shorts.length ? 'warn' : 'good'} />
        <Kpi label="Outstanding picks" value={num(picks.length - done.length)} tone="neutral" />
        <Kpi label="Pick-face availability" value={pct(faceAvail)} sub={`${openRep.length} replen. open`} tone={faceAvail > 70 ? 'good' : 'warn'} />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Panel title="Pick lines completed" className="lg:col-span-2"><Columns series={[{ name: 'Picked', cls: 'bg-chart-1', data: bucket(done.filter((p) => p.status === 'Picked'), range) }, { name: 'Short', cls: 'bg-chart-4', data: bucket(shorts, range) }]} /></Panel>
        <Panel title="Short-pick hotspots" meta="units short by product"><BarList items={shortBySku} format={num} tone="bg-chart-4" /></Panel>
      </div>
      <Tabs defaultValue="replen">
        <TabsList className="mb-3"><TabsTrigger value="replen" data-testid="tab-replen">Replenishment requirements</TabsTrigger><TabsTrigger value="picks" data-testid="tab-picks">Pick lines</TabsTrigger></TabsList>
        <TabsContent value="replen">
          <DataReport<Replen>
            title="Pick-face replenishment" filename="wareiq-replenishment" rows={replen} rowKey={(r) => r.id}
            searchText={(r) => `${r.id} ${r.sku} ${r.name} ${r.pickFace} ${r.source}`}
            facets={[{ key: 'priority', label: 'Priority', value: (r) => r.priority }, { key: 'status', label: 'Status', value: (r) => r.status }, { key: 'wh', label: 'Site', value: (r) => r.wh }]}
            columns={[
              { key: 'id', label: 'Task', value: (r) => r.id, className: 'font-mono' },
              { key: 'sku', label: 'SKU', value: (r) => r.sku, className: 'font-mono' },
              { key: 'name', label: 'Product', value: (r) => r.name },
              { key: 'face', label: 'Pick face', value: (r) => `${r.wh} ${r.pickFace}`, className: 'font-mono' },
              { key: 'min', label: 'Min', value: (r) => r.min, align: 'right' },
              { key: 'cur', label: 'Current', value: (r) => r.current, align: 'right' },
              { key: 'fill', label: 'vs max', value: (r) => r.current / r.max, render: (r) => <Meter value={(r.current / r.max) * 100} tone={r.current < r.min ? 'bad' : 'good'} /> },
              { key: 'req', label: 'Required', value: (r) => r.required, align: 'right' },
              { key: 'src', label: 'Source', value: (r) => r.source, className: 'font-mono text-muted-foreground' },
              { key: 'priority', label: 'Priority', value: (r) => r.priority, render: (r) => <Pill tone={rTone[r.priority]}>{r.priority}</Pill> },
              { key: 'status', label: 'Status', value: (r) => r.status },
            ]}
          />
        </TabsContent>
        <TabsContent value="picks">
          <DataReport<Pick>
            title="Pick lines" filename="wareiq-pick-lines" rows={picks} rowKey={(r) => r.id}
            searchText={(r) => `${r.id} ${r.order} ${r.sku} ${r.name} ${r.location} ${r.operator}`}
            facets={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'op', label: 'Operator', value: (r) => r.operator }]}
            columns={[
              { key: 'id', label: 'Pick', value: (r) => r.id, className: 'font-mono' },
              { key: 'order', label: 'Order', value: (r) => r.order, className: 'font-mono' },
              { key: 'name', label: 'Product', value: (r) => r.name },
              { key: 'loc', label: 'Location', value: (r) => r.location, className: 'font-mono' },
              { key: 'req', label: 'Req.', value: (r) => r.requested, align: 'right' },
              { key: 'picked', label: 'Picked', value: (r) => r.picked, align: 'right' },
              { key: 'sec', label: 'Secs', value: (r) => r.seconds, align: 'right' },
              { key: 'op', label: 'Operator', value: (r) => r.operator },
              { key: 'date', label: 'Time', value: (r) => r.date, render: (r) => dateTime(r.date) },
              { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={pTone[r.status]}>{r.status}</Pill> },
            ]}
            detail={(r) => ({ title: r.id, subtitle: `${r.name} for ${r.order}`, body: <DetailList items={[['Site', r.wh], ['Location', r.location], ['Requested', r.requested], ['Picked', r.picked], ['Short', r.short], ['Duration', `${r.seconds}s`], ['Operator', r.operator], ['Time', dateTime(r.date)], ['Status', r.status]]} /> })}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
