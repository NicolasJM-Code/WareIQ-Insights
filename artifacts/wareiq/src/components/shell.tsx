import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  LayoutDashboard, PackageOpen, Warehouse, Boxes, ScanLine, ClipboardList, Truck, Route, ClipboardCheck,
  Users, TriangleAlert, Settings, Menu, RefreshCw, Database, FlaskConical,
} from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WAREHOUSES, type WhCode } from '@/lib/data';
import { useReport, type RangeDays } from '@/lib/report-context';
import { time } from '@/lib/format';
import { cn } from '@/lib/utils';

export const NAV = [
  { group: 'Overview', items: [{ href: '/', label: 'Executive dashboard', icon: LayoutDashboard }] },
  {
    group: 'Stock flow',
    items: [
      { href: '/inbound', label: 'Inbound / receiving', icon: PackageOpen },
      { href: '/putaway', label: 'Put-away & locations', icon: Warehouse },
      { href: '/inventory', label: 'Inventory', icon: Boxes },
      { href: '/picking', label: 'Replenishment & picking', icon: ScanLine },
      { href: '/outbound', label: 'Order fulfilment', icon: ClipboardList },
      { href: '/dispatch', label: 'Loading & dispatch', icon: Truck },
    ],
  },
  {
    group: 'Control',
    items: [
      { href: '/traceability', label: 'Traceability', icon: Route },
      { href: '/stock-counts', label: 'Counts & adjustments', icon: ClipboardCheck },
      { href: '/labour', label: 'Labour & productivity', icon: Users },
      { href: '/exceptions', label: 'Exceptions', icon: TriangleAlert },
    ],
  },
  { group: 'Administration', items: [{ href: '/settings', label: 'Settings', icon: Settings }] },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const [loc] = useLocation();
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Main">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="px-2 mb-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-sidebar-foreground/45">{g.group}</div>
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = loc === it.href;
              const Icon = it.icon;
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    data-testid={`link-nav-${it.href.replace('/', '') || 'dashboard'}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-2.5 rounded px-2 py-1.5 text-[13px] transition-colors',
                      active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/75 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent/60',
                    )}
                  >
                    <span className={cn('absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-sidebar-primary transition-transform origin-center', active ? 'scale-y-100' : 'scale-y-0')} />
                    <Icon className={cn('h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5', active && 'text-sidebar-primary')} />
                    <span className="truncate">{it.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-5 h-14 border-b border-sidebar-border" data-testid="link-brand">
      <div className="relative h-7 w-7 rounded-sm bg-sidebar-primary grid place-items-center overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-1.5 hazard opacity-80" />
        <span className="font-display text-[13px] font-extrabold text-sidebar-primary-foreground -mt-1">W</span>
      </div>
      <div className="leading-none">
        <div className="font-display text-[17px] font-bold text-sidebar-accent-foreground">WareIQ</div>
        <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-sidebar-foreground/50 mt-0.5">Receiving to dispatch</div>
      </div>
    </Link>
  );
}

function SidebarFooter() {
  return (
    <Link href="/settings" className="m-3 rounded border border-sidebar-border p-3 text-[11px] text-sidebar-foreground/70 hover:border-sidebar-primary/50 transition-colors" data-testid="link-connection-status">
      <div className="flex items-center gap-2 text-sidebar-accent-foreground font-medium text-xs">
        <Database className="h-3.5 w-3.5" /> WMS database
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase text-sidebar-foreground/60">
          <span className="h-1.5 w-1.5 rounded-full bg-sidebar-foreground/40" /> Disconnected
        </span>
      </div>
      <p className="mt-1.5 leading-snug">Showing generated sample data. Live setup needs a server-side service.</p>
    </Link>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid="badge-sample-data" className={cn('inline-flex items-center gap-1.5 rounded-full border border-dashed border-accent-foreground/30 bg-accent/70 px-2.5 py-0.5 text-[11px] font-medium text-accent-foreground', className)}>
          <FlaskConical className="h-3 w-3" /> Sample data
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">Demonstration records generated in the browser. No WMS PostgreSQL database is connected.</TooltipContent>
    </Tooltip>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { warehouse, setWarehouse, range, setRange, refresh, refreshing, refreshedAt, prefs } = useReport();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 min-h-14 py-2">
        <button onClick={onMenu} className="lg:hidden -ml-1 p-2 rounded hover:bg-muted" aria-label="Open navigation" data-testid="button-menu">
          <Menu className="h-5 w-5" />
        </button>
        <Select value={warehouse} onValueChange={(v) => setWarehouse(v as 'ALL' | WhCode)}>
          <SelectTrigger className="h-8 w-[178px] bg-card text-[13px]" data-testid="select-warehouse" aria-label="Warehouse">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All warehouses</SelectItem>
            {WAREHOUSES.map((w) => (
              <SelectItem key={w.code} value={w.code}>{w.code} · {w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div role="radiogroup" aria-label="Date range" className="flex h-8 rounded-md border bg-card p-0.5 text-[12px] font-mono">
          {([1, 7, 30, 90] as RangeDays[]).map((r) => (
            <button key={r} role="radio" aria-checked={range === r} onClick={() => setRange(r)} data-testid={`button-range-${r}`}
              className={cn('px-2.5 rounded-[4px] transition-colors', range === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {r === 1 ? '24h' : `${r}d`}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <DemoBadge className="hidden sm:inline-flex" />
          <div className="hidden md:block text-right leading-tight">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{prefs.refreshInterval === 'manual' ? 'Manual refresh' : `Auto every ${prefs.refreshInterval}m`}</div>
            <div className="text-[12px] font-mono tnum" data-testid="text-refreshed-at">{refreshing ? 'Refreshing…' : `Read ${time(refreshedAt)}`}</div>
          </div>
          <button onClick={() => refresh()} disabled={refreshing} data-testid="button-refresh" aria-label="Refresh report"
            className="h-8 w-8 grid place-items-center rounded-md border bg-card hover:border-primary/50 disabled:opacity-60 transition-colors">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>
      <div className="relative h-px overflow-hidden">
        {refreshing && <div className="absolute inset-y-0 w-1/3 bg-primary sweep" />}
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-[100dvh] flex bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-card focus:px-3 focus:py-2 focus:rounded">Skip to content</a>
      <aside className="hidden lg:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground sticky top-0 h-[100dvh]">
        <Brand />
        <NavList />
        <SidebarFooter />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 p-0 bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Brand />
          <NavList onNavigate={() => setOpen(false)} />
          <SidebarFooter />
        </SheetContent>
      </Sheet>
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar onMenu={() => setOpen(true)} />
        <main id="main" className="flex-1 px-4 md:px-6 py-6 max-w-[1500px] w-full mx-auto">{children}</main>
        <footer className="px-6 py-4 text-[11px] text-muted-foreground font-mono border-t flex flex-wrap gap-x-4 gap-y-1">
          <span>WareIQ reporting demo · read-only</span>
          <span>All figures are generated sample data, not WMS records</span>
        </footer>
      </div>
    </div>
  );
}
