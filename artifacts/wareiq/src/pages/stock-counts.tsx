import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, type Tone } from '@/components/report-kit';
import { COUNTS, type Count } from '@/lib/data';
import { useScoped, useDocTitle } from '@/lib/report-context';
import { num, pct, gbp, dateTime } from '@/lib/format';

const tone: Record<Count['approval'], Tone> = { Approved: 'good', Pending: 'warn', Rejected: 'bad', 'No adjustment': 'neutral' };

export default function StockCounts() {
  useDocTitle('Stock counts & adjustments');
  const rows = useScoped(COUNTS);
  const variances = rows.filter((c) => c.variance !== 0);
  const acc = rows.length ? ((rows.length - variances.length) / rows.length) * 100 : NaN;
  const net = variances.reduce((a, c) => a + c.varianceValue, 0);
  const reasons = Object.entries(variances.reduce<Record<string, number>>((a, c) => ((a[c.reason] = (a[c.reason] ?? 0) + 1), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const catAcc = Object.entries(rows.reduce<Record<string, { n: number; ok: number }>>((a, c) => { a[c.category] ??= { n: 0, ok: 0 }; a[c.category].n++; if (c.variance === 0) a[c.category].ok++; return a; }, {})).map(([label, v]) => ({ label, value: Math.round((v.ok / v.n) * 1000) / 10, hint: `${v.n} counts` })).sort((a, b) => a.value - b.value);
  const plans = Object.entries(rows.reduce<Record<string, number>>((a, c) => ((a[c.plan] = (a[c.plan] ?? 0) + 1), a), {})).map(([label, value]) => ({ label, value }));

  return (
    <div>
      <PageHeader eyebrow="09 · Control" title="Stock counts & adjustments" description="Cycle count results, why stock moved without a transaction, and which adjustments are still waiting for sign-off." />
      <KpiGrid>
        <Kpi label="Counts completed" value={num(rows.length)} sub={`${plans.length} active plans`} tone="info" />
        <Kpi label="Count accuracy" value={pct(acc)} tone={acc > 85 ? 'good' : 'warn'} />
        <Kpi label="Variances" value={num(variances.length)} sub={`${num(variances.reduce((a, c) => a + Math.abs(c.variance), 0))} units`} tone="warn" />
        <Kpi label="Net adjustment value" value={gbp(net)} tone={net < 0 ? 'bad' : 'good'} />
        <Kpi label="Awaiting approval" value={num(rows.filter((c) => c.approval === 'Pending').length)} sub={`${rows.filter((c) => c.repeat).length} repeat discrepancies`} tone="warn" />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Panel title="Adjustment reasons"><BarList items={reasons} format={num} tone="bg-chart-2" /></Panel>
        <Panel title="Accuracy by category" meta="lowest first"><BarList items={catAcc} format={(n) => `${n}%`} tone="bg-chart-3" /></Panel>
        <Panel title="Count plans"><BarList items={plans} format={num} /></Panel>
      </div>
      <DataReport<Count>
        title="Count results" filename="wareiq-stock-counts" rows={rows} rowKey={(r) => r.id}
        searchText={(r) => `${r.id} ${r.location} ${r.sku} ${r.name} ${r.counter} ${r.reason}`}
        facets={[{ key: 'approval', label: 'Approval', value: (r) => r.approval }, { key: 'plan', label: 'Plan', value: (r) => r.plan }, { key: 'var', label: 'Result', value: (r) => (r.variance === 0 ? 'Matched' : r.repeat ? 'Repeat variance' : 'Variance') }]}
        columns={[
          { key: 'id', label: 'Count', value: (r) => r.id, className: 'font-mono' },
          { key: 'loc', label: 'Location', value: (r) => `${r.wh} ${r.location}`, className: 'font-mono' },
          { key: 'name', label: 'Product', value: (r) => r.name },
          { key: 'sys', label: 'System', value: (r) => r.system, align: 'right' },
          { key: 'cnt', label: 'Counted', value: (r) => r.counted, align: 'right' },
          { key: 'var', label: 'Var.', value: (r) => r.variance, align: 'right', render: (r) => <span className={r.variance < 0 ? 'text-destructive' : ''}>{r.variance > 0 ? '+' : ''}{r.variance}</span> },
          { key: 'val', label: 'Value', value: (r) => r.varianceValue, align: 'right', render: (r) => gbp(r.varianceValue) },
          { key: 'reason', label: 'Reason', value: (r) => r.reason },
          { key: 'repeat', label: 'Repeat', value: (r) => (r.repeat ? 'Yes' : ''), render: (r) => (r.repeat ? <Pill tone="bad">Repeat</Pill> : '') },
          { key: 'approval', label: 'Approval', value: (r) => r.approval, render: (r) => <Pill tone={tone[r.approval]}>{r.approval}</Pill> },
        ]}
        detail={(r) => ({ title: r.id, subtitle: `${r.name} at ${r.location}`, body: <DetailList items={[['Plan', r.plan], ['Site', r.wh], ['Counted at', dateTime(r.date)], ['Counter', r.counter], ['System qty', r.system], ['Counted qty', r.counted], ['Variance', r.variance], ['Value', gbp(r.varianceValue)], ['Reason', r.reason], ['Approval', r.approval]]} /> })}
      />
    </div>
  );
}
