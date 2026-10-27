import { Link } from 'wouter';
import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, type Tone } from '@/components/report-kit';
import { STOCK, type StockLine } from '@/lib/data';
import { useWarehouseScoped, useDocTitle } from '@/lib/report-context';
import { num, gbp, date, daysUntil } from '@/lib/format';

const tone: Record<StockLine['status'], Tone> = { OK: 'good', 'Near expiry': 'warn', Expired: 'bad', Negative: 'bad', 'Quality hold': 'info' };

export default function Inventory() {
  useDocTitle('Inventory');
  const rows = useWarehouseScoped(STOCK);
  const onHand = rows.reduce((a, r) => a + Math.max(0, r.onHand), 0);
  const alloc = rows.reduce((a, r) => a + r.allocated, 0);
  const value = rows.reduce((a, r) => a + Math.max(0, r.value), 0);
  const neg = rows.filter((r) => r.onHand < 0);
  const expiring = rows.filter((r) => r.status === 'Near expiry' || r.status === 'Expired');
  const ageBands = [['0–30 days', 0, 30], ['31–60 days', 31, 60], ['61–90 days', 61, 90], ['91–180 days', 91, 999]] as const;
  const ageing = ageBands.map(([label, a, b]) => ({ label, value: rows.filter((r) => r.ageDays >= a && r.ageDays <= b).reduce((s, r) => s + Math.max(0, r.onHand), 0) }));
  const byCat = Object.entries(rows.reduce<Record<string, number>>((a, r) => ((a[r.category] = (a[r.category] ?? 0) + Math.max(0, r.value)), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  return (
    <div>
      <PageHeader eyebrow="04 · Inventory" title="Stock on hand" description="Snapshot position by SKU, batch and location. Inventory is a point-in-time view, so the date range does not apply; the site selector does." />
      <KpiGrid>
        <Kpi label="Units on hand" value={num(onHand)} sub={`${rows.length} stock lines`} tone="info" />
        <Kpi label="Available" value={num(onHand - alloc)} sub={`${num(alloc)} allocated`} tone="good" />
        <Kpi label="Stock value" value={gbp(value)} sub="at standard cost" tone="neutral" />
        <Kpi label="Negative stock" value={num(neg.length)} sub="lines below zero" tone={neg.length ? 'bad' : 'good'} />
        <Kpi label="Expiry risk" value={num(expiring.length)} sub="expired or < 30 days" tone={expiring.length ? 'warn' : 'good'} />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Panel title="Stock ageing" meta="units by days since receipt"><BarList items={ageing} format={num} tone="bg-chart-2" /></Panel>
        <Panel title="Value by category"><BarList items={byCat} format={gbp} /></Panel>
        <Panel title="Inventory discrepancies" action={<Link href="/stock-counts" className="text-[12px] text-primary hover:underline" data-testid="link-counts">Counts</Link>}>
          <ul className="space-y-2 text-[12.5px]">
            {[...neg, ...rows.filter((r) => r.status === 'Quality hold')].slice(0, 7).map((r) => (
              <li key={r.id} className="flex justify-between gap-2"><span className="truncate">{r.name} <span className="font-mono text-muted-foreground">{r.location}</span></span><Pill tone={tone[r.status]}>{r.status === 'Negative' ? `${r.onHand}` : r.status}</Pill></li>
            ))}
            {!neg.length && <li className="text-muted-foreground">No negative stock in this scope.</li>}
          </ul>
        </Panel>
      </div>
      <DataReport<StockLine>
        title="Stock by SKU, batch and location" filename="wareiq-inventory-stock" rows={rows} rowKey={(r) => r.id}
        searchText={(r) => `${r.sku} ${r.name} ${r.batch} ${r.location} ${r.supplier}`}
        facets={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'category', label: 'Category', value: (r) => r.category }, { key: 'wh', label: 'Site', value: (r) => r.wh }]}
        columns={[
          { key: 'sku', label: 'SKU', value: (r) => r.sku, className: 'font-mono' },
          { key: 'name', label: 'Product', value: (r) => r.name },
          { key: 'batch', label: 'Batch', value: (r) => r.batch, className: 'font-mono' },
          { key: 'loc', label: 'Location', value: (r) => `${r.wh} ${r.location}`, className: 'font-mono' },
          { key: 'onHand', label: 'On hand', value: (r) => r.onHand, align: 'right', render: (r) => <span className={r.onHand < 0 ? 'text-destructive font-semibold' : ''}>{num(r.onHand)}</span> },
          { key: 'alloc', label: 'Allocated', value: (r) => r.allocated, align: 'right' },
          { key: 'avail', label: 'Available', value: (r) => r.available, align: 'right' },
          { key: 'expiry', label: 'Expiry', value: (r) => r.expiry, render: (r) => date(r.expiry) },
          { key: 'age', label: 'Age (d)', value: (r) => r.ageDays, align: 'right' },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={tone[r.status]}>{r.status}</Pill> },
        ]}
        detail={(r) => ({ title: r.name, subtitle: `${r.sku} · batch ${r.batch}`, body: (
          <div className="space-y-4">
            <DetailList items={[['Site / location', `${r.wh} ${r.location}`], ['Category', r.category], ['Supplier', r.supplier], ['On hand', num(r.onHand)], ['Allocated', num(r.allocated)], ['Available', num(r.available)], ['Value', gbp(r.value)], ['Received', date(r.receivedAt)], ['Expiry', r.expiry ? `${date(r.expiry)} (${daysUntil(r.expiry)} days)` : 'Non-perishable'], ['Status', r.status]]} />
            <Link href={`/traceability?q=${encodeURIComponent(r.sku)}`} className="inline-flex text-[13px] text-primary font-medium hover:underline" data-testid="link-trace-sku">Trace this SKU</Link>
          </div>
        ) })}
      />
    </div>
  );
}
