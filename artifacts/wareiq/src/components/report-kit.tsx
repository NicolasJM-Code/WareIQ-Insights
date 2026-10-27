import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search, X, Inbox } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useReport } from '@/lib/report-context';
import { downloadCsv } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

export function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return (
    <div className="rise mb-6 flex flex-wrap items-end gap-4 justify-between">
      <div className="max-w-2xl">
        <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-primary/80 flex items-center gap-2">
          <span className="h-2 w-5 hazard rounded-[1px]" />{eyebrow}
        </div>
        <h1 className="font-display text-[28px] md:text-[34px] font-bold leading-[1.05] mt-2" data-testid="text-page-title">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1.5">{description}</p>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
const toneCls: Record<Tone, string> = {
  good: 'bg-[hsl(160_40%_92%)] text-[hsl(160_50%_24%)] border-[hsl(160_35%_80%)]',
  warn: 'bg-[hsl(42_90%_90%)] text-[hsl(30_75%_28%)] border-[hsl(42_70%_75%)]',
  bad: 'bg-[hsl(4_75%_94%)] text-[hsl(4_65%_38%)] border-[hsl(4_60%_84%)]',
  neutral: 'bg-muted text-muted-foreground border-border',
  info: 'bg-[hsl(196_50%_92%)] text-[hsl(196_62%_24%)] border-[hsl(196_40%_80%)]',
};
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-px text-[11px] font-medium', toneCls[tone])}>{children}</span>;
}

export function Panel({ title, meta, children, className, action }: { title: string; meta?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn('rise rounded-md border bg-card', className)}>
      <header className="flex items-center gap-3 px-4 pt-3.5 pb-2">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {meta && <span className="text-[11px] font-mono text-muted-foreground">{meta}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tone = 'neutral', target, testId }: { label: string; value: string; sub?: string; tone?: Tone; target?: string; testId?: string }) {
  const bar = { good: 'bg-chart-3', warn: 'bg-chart-2', bad: 'bg-chart-4', neutral: 'bg-border', info: 'bg-chart-1' }[tone];
  const { refreshing } = useReport();
  return (
    <div className="rise relative rounded-md border bg-card px-4 py-3 overflow-hidden" data-testid={testId}>
      <span className={cn('absolute left-0 top-0 bottom-0 w-[3px]', bar)} />
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-mono">{label}</div>
      {refreshing ? <Skeleton className="h-7 w-20 my-1" /> : <div className="font-display text-[26px] font-bold tnum leading-tight mt-0.5">{value}</div>}
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        {sub && <span>{sub}</span>}
        {target && <span className="ml-auto font-mono text-[11px]">target {target}</span>}
      </div>
    </div>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-5">{children}</div>;
}

export function BarList({ items, format = (n) => String(n), tone = 'bg-chart-1' }: { items: { label: string; value: number; hint?: string }[]; format?: (n: number) => string; tone?: string }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  if (!items.length) return <EmptyMini />;
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={it.label} className="text-[12px]">
          <div className="flex justify-between gap-2 mb-0.5">
            <span className="truncate">{it.label}{it.hint && <span className="text-muted-foreground"> · {it.hint}</span>}</span>
            <span className="font-mono tnum">{format(it.value)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={cn('h-full rounded-full grow-x', tone)} style={{ width: `${(Math.abs(it.value) / max) * 100}%`, animationDelay: `${i * 40}ms` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Columns({ series, height = 140, format = (n) => String(Math.round(n)) }: { series: { name: string; cls: string; data: { label: string; value: number }[] }[]; height?: number; format?: (n: number) => string }) {
  const n = series[0]?.data.length ?? 0;
  const max = Math.max(1, ...series.flatMap((s) => s.data.map((d) => d.value)));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-[11px] text-muted-foreground">
        {series.map((s) => <span key={s.name} className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-sm', s.cls)} />{s.name}</span>)}
        <span className="ml-auto font-mono tnum text-foreground min-h-4">
          {hover != null ? `${series[0].data[hover].label}: ${series.map((s) => `${s.name} ${format(s.data[hover].value)}`).join(' · ')}` : ''}
        </span>
      </div>
      <div className="relative flex items-end gap-[3px] grid-paper rounded-sm" style={{ height }} onMouseLeave={() => setHover(null)} role="img" aria-label={`Column chart: ${series.map((s) => s.name).join(', ')}`}>
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className={cn('flex-1 h-full flex items-end gap-px rounded-sm transition-colors', hover === i && 'bg-primary/5')} onMouseEnter={() => setHover(i)}>
            {series.map((s) => (
              <div key={s.name} className={cn('flex-1 rounded-t-[2px] grow-y', s.cls)} style={{ height: `${(s.data[i].value / max) * 100}%`, animationDelay: `${i * 15}ms` }} />
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] font-mono text-muted-foreground mt-1">
        <span>{series[0]?.data[0]?.label}</span>
        <span>{series[0]?.data[n - 1]?.label}</span>
      </div>
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: Tone }) {
  const t = tone ?? (value > 92 ? 'bad' : value > 80 ? 'warn' : 'good');
  const cls = { good: 'bg-chart-3', warn: 'bg-chart-2', bad: 'bg-chart-4', neutral: 'bg-muted-foreground', info: 'bg-chart-1' }[t];
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><div className={cn('h-full', cls)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
      <span className="font-mono text-[11px] tnum w-9 text-right">{Math.round(value)}%</span>
    </div>
  );
}

function EmptyMini() {
  return <div className="text-[12px] text-muted-foreground py-6 text-center">Nothing in this range.</div>;
}

// ---------------- Data report table ----------------
export interface Col<T> { key: string; label: string; render?: (r: T) => ReactNode; value: (r: T) => string | number | null; align?: 'right'; className?: string }
export interface Facet<T> { key: string; label: string; value: (r: T) => string }

export function DataReport<T>({ title, rows, columns, searchText, facets = [], filename, detail, rowKey, pageSize = 40, testId }: {
  title: string; rows: T[]; columns: Col<T>[]; searchText: (r: T) => string; facets?: Facet<T>[]; filename: string;
  detail?: (r: T) => { title: string; subtitle?: string; body: ReactNode }; rowKey: (r: T) => string; pageSize?: number; testId?: string;
}) {
  const { refreshing } = useReport();
  const [q, setQ] = useState('');
  const [facetVals, setFacetVals] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [limit, setLimit] = useState(pageSize);
  const [selected, setSelected] = useState<T | null>(null);

  const facetOptions = useMemo(() => Object.fromEntries(facets.map((f) => [f.key, [...new Set(rows.map(f.value))].sort()])), [rows, facets]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter((r) => (!needle || searchText(r).toLowerCase().includes(needle)) && facets.every((f) => !facetVals[f.key] || facetVals[f.key] === 'all' || f.value(r) === facetVals[f.key]));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) out = [...out].sort((a, b) => {
        const va = col.value(a), vb = col.value(b);
        if (va == null) return 1;
        if (vb == null) return -1;
        return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
      });
    }
    return out;
  }, [rows, q, facetVals, sort, columns, facets, searchText]);

  const active = q || Object.values(facetVals).some((v) => v && v !== 'all');
  const det = selected && detail ? detail(selected) : null;

  return (
    <section className="rise rounded-md border bg-card" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 p-3 border-b">
        <h2 className="text-[13px] font-semibold mr-2">{title}</h2>
        <span className="text-[11px] font-mono text-muted-foreground tnum" data-testid="text-row-count">{filtered.length} of {rows.length}</span>
        <div className="flex flex-wrap items-center gap-2 ml-auto w-full sm:w-auto">
          <label className="relative flex-1 sm:flex-none">
            <span className="sr-only">Search {title}</span>
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(pageSize); }} placeholder="Search…" data-testid="input-search"
              className="h-8 w-full sm:w-52 rounded-md border bg-background pl-8 pr-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/30 focus:border-primary/50" />
          </label>
          {facets.map((f) => (
            <Select key={f.key} value={facetVals[f.key] ?? 'all'} onValueChange={(v) => { setFacetVals((p) => ({ ...p, [f.key]: v })); setLimit(pageSize); }}>
              <SelectTrigger className="h-8 w-auto min-w-[120px] text-[12px]" data-testid={`select-filter-${f.key}`} aria-label={f.label}>
                <SelectValue placeholder={f.label} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All {f.label.toLowerCase()}</SelectItem>
                {facetOptions[f.key].map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
              </SelectContent>
            </Select>
          ))}
          {active && (
            <button onClick={() => { setQ(''); setFacetVals({}); }} className="h-8 px-2 text-[12px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" data-testid="button-clear-filters">
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          )}
          <button
            onClick={() => {
              downloadCsv(filename, columns.map((c) => ({ label: c.label, value: c.value })), filtered);
              toast({ title: 'CSV downloaded', description: `${filtered.length} filtered rows, marked as sample data.` });
            }}
            disabled={!filtered.length}
            className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-[12px] font-medium inline-flex items-center gap-1.5 hover:opacity-90 active:scale-[.98] transition disabled:opacity-50"
            data-testid="button-download-csv"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map((c) => {
                const s = sort?.key === c.key ? sort.dir : 0;
                return (
                  <th key={c.key} className={cn('font-medium text-[11px] uppercase tracking-wide whitespace-nowrap px-3 py-2', c.align === 'right' ? 'text-right' : 'text-left')} aria-sort={s === 1 ? 'ascending' : s === -1 ? 'descending' : 'none'}>
                    <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort(s === 0 ? { key: c.key, dir: 1 } : s === 1 ? { key: c.key, dir: -1 } : null)} data-testid={`button-sort-${c.key}`}>
                      {c.label}
                      {s === 1 ? <ArrowUp className="h-3 w-3" /> : s === -1 ? <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-30" />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {refreshing
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} className="border-t">{columns.map((c) => <td key={c.key} className="px-3 py-2.5"><Skeleton className="h-3.5 w-full max-w-[120px]" /></td>)}</tr>
                ))
              : filtered.slice(0, limit).map((r) => (
                  <tr key={rowKey(r)} onClick={() => detail && setSelected(r)} onKeyDown={(e) => { if (detail && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelected(r); } }}
                    tabIndex={detail ? 0 : undefined} data-testid={`row-${rowKey(r)}`}
                    className={cn('border-t transition-colors', detail && 'cursor-pointer hover:bg-accent/40 focus:bg-accent/40 outline-none')}>
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-3 py-2 whitespace-nowrap', c.align === 'right' && 'text-right font-mono tnum', c.className)}>{c.render ? c.render(r) : (c.value(r) ?? '—')}</td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
        {!refreshing && !filtered.length && (
          <div className="py-12 text-center">
            <Inbox className="h-8 w-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm font-medium mt-2">No rows match</p>
            <p className="text-[12px] text-muted-foreground">Widen the date range, switch warehouse or clear filters.</p>
          </div>
        )}
      </div>
      {filtered.length > limit && (
        <div className="border-t p-2 text-center">
          <button onClick={() => setLimit((l) => l + pageSize)} className="text-[12px] text-primary font-medium hover:underline" data-testid="button-show-more">Show {Math.min(pageSize, filtered.length - limit)} more rows</button>
        </div>
      )}
      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {det && (
            <>
              <SheetHeader>
                <SheetTitle className="font-display text-xl">{det.title}</SheetTitle>
                {det.subtitle && <SheetDescription>{det.subtitle}</SheetDescription>}
              </SheetHeader>
              <div className="mt-4 text-sm">{det.body}</div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

export function DetailList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="divide-y border rounded-md">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 px-3 py-2 text-[13px]">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
