import { useState } from 'react';
import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, type Tone } from '@/components/report-kit';
import { EXCEPTIONS, type Exception, type ExType } from '@/lib/data';
import { useScoped, useDocTitle } from '@/lib/report-context';
import { num, dateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const sev: Record<Exception['severity'], Tone> = { Critical: 'bad', High: 'warn', Medium: 'info', Low: 'neutral' };
const st: Record<Exception['status'], Tone> = { Open: 'bad', Acknowledged: 'warn', Resolved: 'good' };
const TYPES: ExType[] = ['Overdue task', 'Stock discrepancy', 'Near-expiry stock', 'Expired stock', 'Blocked order', 'Missed cut-off', 'Failed transaction'];

export default function Exceptions() {
  useDocTitle('Exceptions');
  const all = useScoped(EXCEPTIONS);
  const [type, setType] = useState<ExType | null>(null);
  const rows = type ? all.filter((e) => e.type === type) : all;
  const open = all.filter((e) => e.status !== 'Resolved');
  const owners = Object.entries(open.reduce<Record<string, number>>((a, e) => ((a[e.owner] = (a[e.owner] ?? 0) + 1), a), {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6);

  return (
    <div>
      <PageHeader eyebrow="11 · Exceptions" title="Operational exceptions" description="Everything that broke the plan: overdue work, stock that does not reconcile, expiring batches, blocked orders and failed postings." />
      <KpiGrid>
        <Kpi label="Open" value={num(all.filter((e) => e.status === 'Open').length)} tone="bad" />
        <Kpi label="Acknowledged" value={num(all.filter((e) => e.status === 'Acknowledged').length)} tone="warn" />
        <Kpi label="Resolved" value={num(all.filter((e) => e.status === 'Resolved').length)} tone="good" />
        <Kpi label="Critical unresolved" value={num(open.filter((e) => e.severity === 'Critical').length)} tone="bad" />
        <Kpi label="Failed transactions" value={num(all.filter((e) => e.type === 'Failed transaction').length)} tone="info" />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Panel title="Exception categories" meta="select to focus the table" className="lg:col-span-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {TYPES.map((t) => {
              const n = open.filter((e) => e.type === t).length;
              const on = type === t;
              return (
                <button key={t} onClick={() => setType(on ? null : t)} aria-pressed={on} data-testid={`button-extype-${t.replace(/\s/g, '-').toLowerCase()}`}
                  className={cn('text-left rounded border px-3 py-2 transition-all hover:-translate-y-0.5', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background/60 hover:border-primary/50')}>
                  <div className={cn('text-[11px]', on ? 'opacity-80' : 'text-muted-foreground')}>{t}</div>
                  <div className="font-display text-xl font-bold tnum">{n}</div>
                  <div className={cn('text-[10px] font-mono', on ? 'opacity-70' : 'text-muted-foreground')}>unresolved</div>
                </button>
              );
            })}
          </div>
        </Panel>
        <Panel title="Unresolved by owner"><BarList items={owners} format={num} tone="bg-chart-4" /></Panel>
      </div>
      <DataReport<Exception>
        key={type ?? 'all'}
        title={type ? `Exceptions: ${type}` : 'All exceptions'} filename="wareiq-exceptions" rows={rows} rowKey={(r) => r.id}
        searchText={(r) => `${r.id} ${r.type} ${r.ref} ${r.detail} ${r.owner}`}
        facets={[{ key: 'severity', label: 'Severity', value: (r) => r.severity }, { key: 'status', label: 'Status', value: (r) => r.status }, { key: 'wh', label: 'Site', value: (r) => r.wh }]}
        columns={[
          { key: 'id', label: 'ID', value: (r) => r.id, className: 'font-mono' },
          { key: 'sev', label: 'Severity', value: (r) => ['Critical', 'High', 'Medium', 'Low'].indexOf(r.severity), render: (r) => <Pill tone={sev[r.severity]}>{r.severity}</Pill> },
          { key: 'type', label: 'Type', value: (r) => r.type },
          { key: 'ref', label: 'Reference', value: (r) => r.ref, className: 'font-mono' },
          { key: 'detail', label: 'Detail', value: (r) => r.detail, className: 'max-w-[320px] truncate' },
          { key: 'wh', label: 'Site', value: (r) => r.wh },
          { key: 'date', label: 'Raised', value: (r) => r.date, render: (r) => dateTime(r.date) },
          { key: 'owner', label: 'Owner', value: (r) => r.owner },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Pill tone={st[r.status]}>{r.status}</Pill> },
        ]}
        detail={(r) => ({ title: r.id, subtitle: r.type, body: (
          <div className="space-y-3">
            <p className="text-[13px]">{r.detail}</p>
            <DetailList items={[['Severity', r.severity], ['Reference', r.ref], ['Site', r.wh], ['Raised', dateTime(r.date)], ['Owner', r.owner], ['Status', r.status]]} />
            <p className="text-[11px] text-muted-foreground">Reporting is read-only. Acknowledge and resolve exceptions in the WMS itself.</p>
          </div>
        ) })}
      />
      <p className="mt-3 text-[11px] text-muted-foreground">Configurable exception alerts are defined in Settings and require the live reporting service.</p>
    </div>
  );
}
