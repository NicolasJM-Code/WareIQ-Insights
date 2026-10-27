import type { ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { status?: number; data?: unknown; message?: string };
    const d = e.data as { error?: unknown } | null | undefined;
    const base = d && typeof d.error === 'string' ? d.error : e.message || 'Request failed';
    if (e.status === 409) return `Conflict: ${base}`;
    return base;
  }
  return 'Request failed';
}

export function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
        active ? 'bg-chart-3/15 text-chart-3' : 'bg-muted text-muted-foreground line-through'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-chart-3' : 'bg-muted-foreground'}`} />
      {active ? 'Active' : 'Disabled'}
    </span>
  );
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{children}</span>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div data-testid="text-form-error" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function StatePanel({ title, body, onRetry, action, tone = 'neutral' }: { title: string; body: string; onRetry?: () => void; action?: ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <div className="mx-auto max-w-xl rise">
      <div className={`h-2 rounded-t-md ${tone === 'warn' ? 'hazard' : 'bg-primary'}`} />
      <div className="rounded-b-md border border-t-0 bg-card p-8">
        <h2 className="font-display text-2xl font-bold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        <div className="mt-6 flex gap-2">
          {onRetry && (
            <Button data-testid="button-retry" onClick={onRetry} variant="outline">
              <RotateCcw className="mr-2 h-4 w-4" /> Retry
            </Button>
          )}
          {action}
        </div>
      </div>
    </div>
  );
}

export function SkeletonBlock() {
  return (
    <div className="space-y-4" data-testid="status-loading">
      <div className="h-10 w-72 animate-pulse rounded bg-muted" />
      <div className="grid gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-md bg-muted" />)}
      </div>
      <div className="h-80 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

export const selectCls = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';
