import { PageHeader, Kpi, KpiGrid, Panel, BarList, Columns, DataReport, DetailList, Pill, type Tone } from '@/components/report-kit';
import { RECEIPTS, type Receipt } from '@/lib/data';
import { useReport, useScoped, useDocTitle } from '@/lib/report-context';
import { bucket, num, pct, dateTime, mins } from '@/lib/format';

const tone: Record<Receipt['status'], Tone> = { Received: 'good', Partial: 'warn', 'Over-received': 'info', Outstanding: 'bad' };

export default function Inbound() {
  useDocTitle('Inbound / receiving');
  const { range, prefs } = useReport();
  const rows = useScoped(RECEIPTS);
  const done = rows.filter((r) => r.status !== 'Outstanding');
  const expected = rows.reduce((a, r) => a + r.expected, 0);
  const received = rows.reduce((a, r) => a + r.received, 0);
  const disc = rows.filter((r) => r.variance !== 0 && r.status !== 'Outstanding');
  const d2s = done.length ? done.reduce((a, r) => a + (r.dockToStockMin ?? 0), 0) / done.length : NaN;
  const bySupplier = Object.entries(rows.reduce<Record<string, number>>((a, r) => ((a[r.supplier] = (a[r.supplier] ?? 0) + r.received), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const byReceiver = Object.entries(done.reduce<Record<string, number>>((a, r) => ((a[r.receiver] = (a[r.receiver] ?? 0) + r.lines), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6);

  return (
    <div>
      <PageHeader eyebrow="02 · Inbound" title="Receiving" description="Supplier deliveries against purchase orders: what arrived, what is short, and how long it sat on the dock." />
      <KpiGrid>
        <Kpi label="Receipts" value={num(rows.length)} sub={`${num(done.length)} closed`} tone="info" />
        <Kpi label="Received vs expected" value={pct(expected ? (received / expected) * 100 : NaN)} sub={`${num(received)} / ${num(expected)} units`} tone="good" />
        <Kpi label="Discrepancies" value={num(disc.length)} sub={`${pct(done.length ? (disc.length / done.length) * 100 : NaN)} of receipts`} tone={disc.length ? 'warn' : 'good'} />
        <Kpi label="Dock-to-stock" value={mins(Number.isFinite(d2s) ? d2s : null)} target={`${prefs.targetDockToStockMin}m`} tone={d2s <= prefs.targetDockToStockMin ? 'good' : 'bad'} />
        <Kpi label="Outstanding" value={num(rows.length - done.length)} sub="deliveries not yet booked" tone={rows.length - done.length ? 'bad' : 'good'} />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Panel title="Units received" meta="by period" className="lg:col-span-1"><Columns series={[{ name: 'Units', cls: 'bg-chart-1', data: bucket(rows, range, (r) => r.received) }]} format={num} /></Panel>
        <Panel title="Receipts by supplier" meta="units"><BarList items={bySupplier} format={num} /></Panel>
        <Panel title="Receiving productivity" meta="lines booked"><BarList items={byReceiver} format={num} tone="bg-chart-3" /></Panel>
      </div>
      <DataReport<Receipt>
        title="Goods receipts" filename="wareiq-inbound-receipts" rows={rows} rowKey={(r) => r.id}
        searchText={(r) => `${r.id} ${r.po} ${r.supplier} ${r.dock} ${r.receiver}`}
        facets={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'supplier', label: 'Supplier', value: (r) => r.supplier }, { key: 'wh', label: 'Site', value: (r) => r.wh }]}
        columns={[
          { key: 'id', label: 'GRN', value: (r) => r.id, className: 'font-mono' },
          { key: 'po', label: 'PO', value: (r) => r.po, className: 'font-mono text-muted-foreground' },
          { key: 'supplier', label: 'Supplier', value: (r) => r.supplier },
          { key: 'wh', label: 'Site', value: (r) => r.wh },
          { key: 'date', label: 'Arrived', value: (r) => r.date, render: (r) => dateTime(r.date) },
          { key: 'expected', label: 'Expected', value: (r) => r.expected, align: 'right' },
          { key: 'received', label: 'Received', value: (r) => r.received, align: 'right' },
          { key: 'variance', label: 'Var.', value: (r) => r.variance, align: 'right', render: (r) => <span className={r.variance < 0 ? 'text-destructive' : r.variance > 0 ? 'text-primary' : ''}>{r.variance > 0 ? '+' : ''}{r.variance}</span> },
          { key: 'd2s', label: 'Dock-to-stock', value: (r) => r.dockToStockMin, align: 'right', render: (r) => mins(r.dockToStockMin) },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={tone[r.status]}>{r.status}</Pill> },
        ]}
        detail={(r) => ({ title: r.id, subtitle: `${r.supplier} · ${r.po}`, body: <DetailList items={[['Site', r.wh], ['Dock', r.dock], ['Arrived', dateTime(r.date)], ['Lines', r.lines], ['Expected units', num(r.expected)], ['Received units', num(r.received)], ['Variance', r.variance], ['Dock-to-stock', mins(r.dockToStockMin)], ['Received by', r.receiver], ['Status', <Pill tone={tone[r.status]}>{r.status}</Pill>]]} /> })}
      />
    </div>
  );
}
