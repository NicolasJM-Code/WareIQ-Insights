import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { changeAccessRole, getListAccessHistoryQueryKey, getListAccessUsersQueryKey, listAccessUsers, getGetAccessSessionQueryKey, type PlatformAccessRole as AccessRole, type PlatformAccessUser as AccessUser } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { ChevronLeft, ChevronRight, RefreshCw, ShieldAlert, UserCheck, UserX, Users } from 'lucide-react';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Pill } from '@/components/report-kit';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const PAGE = 25;
const roleLabel: Record<AccessRole, string> = { admin: 'Administrator', supervisor: 'Legacy Supervisor', unassigned: 'No platform role' };
const consequence: Record<AccessRole, string> = {
  admin: 'They will gain platform administration, including settings and account approval. Client and warehouse assignments are managed separately in User access.',
  supervisor: 'This legacy global role does not grant client reporting access. Reporting requires approval in User access.',
  unassigned: 'They will lose platform administrator rights on their next API request. Existing client reporting membership is unchanged. To revoke reporting too, disable that user in User access. Open screens refresh within 30 seconds or on focus.',
};

type Pending = { user: AccessUser; role: AccessRole };

function errInfo(e: unknown): { status: number | null; message: string } {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  const data = (e as { data?: unknown })?.data;
  const server = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error.slice(0, 200) : null;
  const fallback: Record<number, string> = {
    400: 'The request was rejected as invalid.', 403: 'You are not permitted to make this change.', 404: 'This account no longer exists.',
    409: 'This account changed since the list was loaded.', 503: 'Permissions service is unavailable. Try again shortly.',
  };
  return { status, message: server ?? (status ? fallback[status] : undefined) ?? 'The request failed. Check your connection and retry.' };
}

function initials(u: AccessUser) {
  const src = u.name?.trim() || u.email;
  return src.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
}

export function AccessManagement() {
  const { userId, sessionId } = useAuth();
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const listKey = [...getListAccessUsersQueryKey({ offset }), userId, sessionId] as const;
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => listAccessUsers({ offset }, { signal, credentials: 'same-origin', cache: 'no-store' }),
    enabled: !!userId,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    placeholderData: keepPreviousData,
  });

  const refreshAll = () => Promise.all([
    qc.invalidateQueries({ queryKey: getListAccessHistoryQueryKey() }),
    qc.invalidateQueries({ queryKey: getListAccessUsersQueryKey() }),
    qc.invalidateQueries({ queryKey: ['wareiq-access'] }),
    qc.invalidateQueries({ queryKey: getGetAccessSessionQueryKey() }),
    qc.invalidateQueries({ queryKey: ['wareiq-settings-access'] }),
  ]);

  const mutation = useMutation({
    mutationFn: (p: Pending) => changeAccessRole(p.user.id, { role: p.role, expectedRole: p.user.role }, { credentials: 'same-origin' }),
    onSuccess: (updated, p) => {
      setPending(null);
      const text = updated.role === 'unassigned'
        ? `Platform role removed for ${p.user.email}. Client reporting membership is unchanged; disable it in User access to revoke reporting too.`
        : `${p.user.email} is now ${roleLabel[updated.role]}.`;
      setNotice({ tone: 'good', text });
      toast({ title: 'Account role updated', description: text });
    },
    onError: (e, p) => {
      const { status, message } = errInfo(e);
      setPending(null);
      const text = status === 409 ? `${message} The account list has been reloaded; review ${p.user.email} and try again.` : message;
      setNotice({ tone: 'bad', text });
      toast({ title: status === 409 ? 'Change conflicted' : 'Role change failed', description: text, variant: 'destructive' });
    },
    onSettled: () => { void refreshAll(); },
  });

  const data = list.data;
  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit || PAGE;
  const pendingCount = users.filter((u) => u.role === 'unassigned').length;

  return (
    <section className="rise rounded-md border bg-card lg:col-span-2" data-testid="section-access-management">
      <header className="flex flex-wrap items-center gap-2.5 px-5 py-3.5 border-b">
        <Users className="h-4 w-4 text-primary" />
        <h2 className="text-[14px] font-semibold">Platform administrator approval</h2>
        <Pill tone="good">Server enforced</Pill>
        {data && pendingCount > 0 && <Pill tone="neutral">{pendingCount} without a platform role on this page</Pill>}
        <button type="button" onClick={() => void list.refetch()} disabled={list.isFetching} className="ml-auto text-[12px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid="button-refresh-users">
          <RefreshCw className={cn('h-3.5 w-3.5', list.isFetching && 'animate-spin')} /> {list.isFetching ? 'Refreshing' : 'Refresh'}
        </button>
      </header>

      <div className="p-5 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr] text-[12px] text-muted-foreground">
          <p><span className="font-semibold text-foreground">Reporting approval.</span> New accounts have no reporting access until approved for a client, role and warehouses in <Link href="/user-access" className="underline text-primary">User access</Link>. Use that screen to approve or revoke reporting. The controls below only grant or remove platform administrator rights; they never replace client membership.</p>
          <p><span className="font-semibold text-foreground">Safety.</span> You cannot change your own role or remove the last active administrator. Unverified or restricted accounts cannot be granted administrator access. Every change is checked against the role shown here. Platform revocation applies on the next API request; active screens refresh within 30 seconds or on focus.</p>
        </div>

        {notice && (
          <div role={notice.tone === 'bad' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-md border p-3 text-[12.5px]', notice.tone === 'good' ? 'border-primary/30 bg-primary/5' : 'border-destructive/30 bg-destructive/5 text-destructive')} data-testid="status-access-notice">
            <span className="flex-1">{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-[11.5px] underline shrink-0">Dismiss</button>
          </div>
        )}

        {list.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading accounts">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 rounded-md bg-muted animate-pulse" />)}
          </div>
        ) : list.isError && !data ? (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-[13px]">
            <div className="font-semibold text-destructive flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Accounts could not be loaded</div>
            <p className="mt-1 text-muted-foreground">{errInfo(list.error).message}</p>
            <button type="button" onClick={() => void list.refetch()} className="mt-3 h-8 px-3 rounded-md border bg-background text-[12.5px] font-medium" data-testid="button-retry-users">Retry</button>
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center">
            <Users className="h-6 w-6 mx-auto text-muted-foreground" />
            <p className="mt-2 text-[13px] font-medium">No accounts on this page</p>
            <p className="text-[12px] text-muted-foreground">Accounts appear here after their first sign-in.</p>
            {offset > 0 && <button type="button" onClick={() => setOffset(0)} className="mt-3 text-[12px] underline">Back to first page</button>}
          </div>
        ) : (
          <>
            {list.isError && <p role="alert" className="text-[12px] text-destructive">Refresh failed: {errInfo(list.error).message} Showing the last loaded list.</p>}
            <ul className={cn('divide-y rounded-md border', list.isPlaceholderData && 'opacity-60')} data-testid="list-access-users">
              {users.map((u) => {
                const self = u.id === userId;
                const blocked = !u.emailVerified || u.restricted;
                const busy = mutation.isPending;
                const grants = (['admin'] as const).filter((r) => r !== u.role);
                return (
                  <li key={u.id} className={cn('grid gap-3 p-3 md:grid-cols-[1fr_auto] md:items-center', u.role === 'unassigned' && 'bg-[hsl(42_90%_94%)]/50')} data-testid={`row-user-${u.id}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-9 w-9 shrink-0 rounded-md bg-muted grid place-items-center font-mono text-[12px] font-semibold">{initials(u)}</div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium truncate">{u.name || 'Unnamed account'}{self && <span className="text-muted-foreground font-normal"> (you)</span>}</div>
                        <div className="text-[11.5px] font-mono text-muted-foreground truncate">{u.email}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Pill tone={u.role === 'admin' ? 'info' : 'neutral'}>{roleLabel[u.role]}</Pill>
                          {!u.emailVerified && <Pill tone="bad">Email unverified</Pill>}
                          {u.restricted && <Pill tone="bad">Restricted</Pill>}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
                      {self ? <span className="text-[11.5px] text-muted-foreground">Your own role cannot be changed here</span> : (
                        <>
                          {grants.map((r) => (
                            <button key={r} type="button" disabled={busy || blocked} title={blocked ? 'Unverified or restricted accounts cannot be granted access' : undefined}
                              onClick={() => setPending({ user: u, role: r })}
                              className="h-8 px-3 rounded-md border bg-background text-[12px] font-medium inline-flex items-center gap-1.5 hover:border-primary/50 disabled:opacity-50 disabled:cursor-not-allowed transition"
                              data-testid={`button-set-${r}-${u.id}`}>
                              <UserCheck className="h-3.5 w-3.5" /> {u.role === 'unassigned' ? 'Approve as' : 'Change to'} {roleLabel[r]}
                            </button>
                          ))}
                          {u.role !== 'unassigned' && (
                            <button type="button" disabled={busy} onClick={() => setPending({ user: u, role: 'unassigned' })}
                              className="h-8 px-3 rounded-md border border-destructive/40 text-destructive bg-background text-[12px] font-medium inline-flex items-center gap-1.5 hover:bg-destructive/5 disabled:opacity-50 transition"
                              data-testid={`button-revoke-${u.id}`}>
                              <UserX className="h-3.5 w-3.5" /> Remove platform role
                            </button>
                          )}
                          {blocked && u.role === 'unassigned' && <span className="text-[11px] text-muted-foreground w-full md:text-right">Cannot approve until verified and unrestricted</span>}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between text-[12px] text-muted-foreground">
              <span className="font-mono">{offset + 1}–{Math.min(offset + users.length, total)} of {total}</span>
              <div className="flex gap-1">
                <button type="button" disabled={offset === 0 || list.isFetching} onClick={() => setOffset(Math.max(0, offset - limit))} className="h-8 w-8 grid place-items-center rounded-md border disabled:opacity-40" aria-label="Previous page" data-testid="button-prev-page"><ChevronLeft className="h-4 w-4" /></button>
                <button type="button" disabled={offset + limit >= total || list.isFetching} onClick={() => setOffset(offset + limit)} className="h-8 w-8 grid place-items-center rounded-md border disabled:opacity-40" aria-label="Next page" data-testid="button-next-page"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          </>
        )}
      </div>

      <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o && !mutation.isPending) setPending(null); }}>
        <AlertDialogContent>
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{pending.role === 'unassigned' ? 'Remove platform role' : `Approve as ${roleLabel[pending.role]}`}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2 text-[13px]">
                    <p><span className="font-medium text-foreground">{pending.user.name || 'Unnamed account'}</span> <span className="font-mono">({pending.user.email})</span></p>
                    <p>Current role: <span className="font-medium text-foreground">{roleLabel[pending.user.role]}</span>. New role: <span className="font-medium text-foreground">{roleLabel[pending.role]}</span>.</p>
                    <p>{consequence[pending.role]}</p>
                    <p className="text-[12px]">If this account changed since you loaded the list, the server rejects this change and the list reloads.</p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
                <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(pending)}
                  className={cn('h-9 px-4 rounded-md text-[13px] font-medium disabled:opacity-50', pending.role === 'unassigned' ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground')}
                  data-testid="button-confirm-role">
                  {mutation.isPending ? 'Saving' : pending.role === 'unassigned' ? 'Remove platform role' : `Confirm ${roleLabel[pending.role]}`}
                </button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
