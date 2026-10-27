import { useMemo, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { FileBarChart, FilePen, LayoutPanelTop, HardDrive, SearchX } from 'lucide-react';
import { SECTIONS, sectionForPath, type CatalogCtx, type Section } from '@/lib/report-catalog';
import { useOwnReportsState } from '@/lib/own-reports-store';
import { useReport } from '@/lib/report-context';
import { cn } from '@/lib/utils';
import { useAccess } from '@/lib/use-access';

export function useCatalogCtx(): CatalogCtx {
  const { prefs } = useReport();
  const { reports } = useOwnReportsState();
  return useMemo(() => {
    const ownCounts: Record<string, number> = {};
    for (const r of reports) ownCounts[r.section] = (ownCounts[r.section] ?? 0) + 1;
    return { prefs, ownCounts };
  }, [prefs, reports]);
}

export function sectionLinks(s: Section) {
  return [
    { key: 'overview', href: s.overview, label: 'Overview', icon: LayoutPanelTop },
    { key: 'reports', href: `${s.base}/reports`, label: 'Reports', icon: FileBarChart },
    { key: 'own', href: `${s.base}/own-reports`, label: 'Own reports', icon: FilePen },
  ] as const;
}
export function activeSub(s: Section, loc: string) {
  if (loc.startsWith(`${s.base}/own-reports`)) return 'own';
  if (loc.startsWith(`${s.base}/reports`)) return 'reports';
  return 'overview';
}

/** Tab strip shown above every section page (overview pages untouched). */
export function SectionTabs() {
  const [loc] = useLocation();
  const s = sectionForPath(loc);
  const { reports } = useOwnReportsState();
  const access = useAccess();
  if (!s) return null;
  if (!access.data || !s.defaults.some((r) => access.data.reportIds.includes(r.id))) return null;
  const act = activeSub(s, loc);
  const own = reports.filter((r) => r.section === s.id).length;
  return (
    <div className="mb-5 -mt-1 flex items-center gap-1 border-b overflow-x-auto" role="tablist" aria-label={`${s.label} views`}>
      {sectionLinks(s).filter((l) => l.key !== 'own' || access.data.canCreateOwnReports).map((l) => {
        const on = act === l.key;
        const Icon = l.icon;
        return (
          <Link key={l.key} href={l.href} role="tab" aria-selected={on} data-testid={`tab-section-${l.key}`}
            className={cn('relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-[13px] border-b-2 transition-colors',
              on ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="h-3.5 w-3.5" />{l.label}
            {l.key === 'reports' && <span className="font-mono text-[10px] text-muted-foreground tnum">{s.defaults.filter((r) => access.data.reportIds.includes(r.id)).length}</span>}
            {l.key === 'own' && own > 0 && <span className="font-mono text-[10px] rounded-sm bg-accent px-1 text-accent-foreground tnum">{own}</span>}
          </Link>
        );
      })}
      <span className="ml-auto hidden md:inline text-[10px] font-mono uppercase tracking-[0.16em] text-muted-foreground pr-1">{s.eyebrow}</span>
    </div>
  );
}

export function BrowserOnlyNote({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-md border border-dashed border-accent-foreground/30 bg-accent/50 px-3 py-2 text-[12px] text-accent-foreground', className)} data-testid="text-browser-only">
      <HardDrive className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <p><strong className="font-semibold">Saved to your account.</strong> Report definitions are private to your login and client, and require your role's permission. Previous browser-only definitions remain untouched and are not automatically imported. Live results require the WMS connection and assigned sites.</p>
    </div>
  );
}

export function MissingPanel({ title, body, back, backLabel }: { title: string; body: string; back: string; backLabel: string }) {
  return (
    <div className="rise rounded-md border bg-card py-14 px-6 text-center grid-paper" data-testid="status-not-found">
      <SearchX className="h-8 w-8 mx-auto text-muted-foreground/60" />
      <h2 className="font-display text-xl font-bold mt-3">{title}</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{body}</p>
      <Link href={back} className="mt-4 inline-flex h-8 items-center rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground" data-testid="link-back">{backLabel}</Link>
    </div>
  );
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'primary' }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-mono whitespace-nowrap',
      tone === 'accent' ? 'bg-accent text-accent-foreground border-accent-foreground/20' : tone === 'primary' ? 'bg-primary/10 text-primary border-primary/25' : 'bg-muted text-muted-foreground border-border')}>
      {children}
    </span>
  );
}

export const btn = {
  primary: 'h-8 px-3 rounded-md bg-primary text-primary-foreground text-[12px] font-medium inline-flex items-center gap-1.5 hover:opacity-90 active:scale-[.98] transition disabled:opacity-50 disabled:pointer-events-none',
  ghost: 'h-8 px-3 rounded-md border bg-card text-[12px] font-medium inline-flex items-center gap-1.5 hover:border-primary/50 transition-colors disabled:opacity-50 disabled:pointer-events-none',
  icon: 'h-7 w-7 grid place-items-center rounded border bg-card text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40 disabled:pointer-events-none',
};

export const ALL_SECTIONS = SECTIONS;
