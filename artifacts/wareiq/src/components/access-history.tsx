import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { useQuery } from '@tanstack/react-query';
import { getListAccessHistoryQueryKey, listAccessHistory, type ListAccessHistoryParams } from '@workspace/api-client-react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { Pill } from '@/components/report-kit';

const roles: Record<string, string> = { admin: 'Administrator', supervisor: 'Legacy Supervisor', unassigned: 'No platform role' };
const outcomes = { succeeded: 'Confirmed', unchanged: 'No change needed', denied: 'Denied', failed: 'Not attempted', unconfirmed: 'Unconfirmed' };
const reasons: Record<string, string> = {
  confirmation_pending: 'Confirmation is pending or was interrupted. Refresh accounts before retrying.',
  provider_outcome_unknown: 'The provider did not confirm the outcome. Refresh accounts before retrying.',
  administrator_required: 'Administrator access required',
  self_change_denied: 'Self-role changes are not allowed',
  stale_role: 'Account role changed since confirmation',
  target_restricted: 'Account is restricted or its primary email is unverified',
  last_administrator: 'Last active administrator protected',
  invalid_request: 'Invalid request; submitted details were not retained',
  change_not_started: 'Stopped before a provider update was attempted',
  already_assigned: 'The requested role was already assigned',
  role_confirmed: 'Provider confirmed the requested role',
  policy_denied: 'Access policy denied this change',
  command_target_ineligible: 'Recovery command requires one verified, unrestricted target account',
};

export function AccessHistory() {
  const { userId, sessionId } = useAuth();
  const [pages, setPages] = useState<ListAccessHistoryParams[]>([{}]);
  const params = pages[pages.length - 1]!;
  const history = useQuery({
    queryKey: [...getListAccessHistoryQueryKey(params), userId, sessionId],
    queryFn: ({ signal }) => listAccessHistory(params, { signal, credentials: 'same-origin', cache: 'no-store' }),
    enabled: !!userId, retry: false, staleTime: 15_000,
    refetchInterval: 30_000, refetchOnWindowFocus: 'always',
  });
  return (
    <section className="rounded-md border bg-card lg:col-span-2" data-testid="section-access-history">
      <header className="flex items-center gap-2.5 border-b px-5 py-3.5">
        <ScrollText className="h-4 w-4 text-primary" />
        <h2 className="text-[14px] font-semibold">Platform access history</h2>
        <button type="button" disabled={history.isFetching} onClick={() => { setPages([{}]); void history.refetch(); }}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground disabled:opacity-50">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh history
        </button>
      </header>
      <div className="space-y-3 p-5">
        <p className="text-[12px] text-muted-foreground">Application-database records of platform role attempts made through Settings and the approved recovery command, including policy denials. Account IDs identify authenticated Settings actors; operator: IDs identify terminal operators by their declared non-personal identifier, not a verified app administrator. No email addresses or provider metadata are retained. Reporting membership changes, settings, exports, direct Clerk edits and other tools are not included. Earlier activity is not backfilled.</p>
        <p className="text-[12px] text-muted-foreground">Unconfirmed means the attempt may still be running or its outcome could not be saved. It does not prove a role changed. Check the current account list before retrying. Old and confirmed roles are shown only when known; denied requests from non-administrators omit target details.</p>
        {history.isPending ? <p role="status" className="text-[13px]">Loading access history…</p> : history.isError ? (
          <div role="alert" className="text-[13px] text-destructive">
            Access history could not be refreshed. {history.data ? 'The last loaded records are shown below.' : 'No records could be loaded.'}
            <button type="button" className="ml-2 underline" onClick={() => void history.refetch()}>Retry history</button>
          </div>
        ) : history.data?.entries.length === 0 ? <p className="rounded-md border border-dashed p-5 text-[13px]">No platform role attempts recorded yet.</p> : null}
        {!!history.data?.entries.length && <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-[12px]" data-testid="table-access-history">
            <thead className="border-b bg-muted/50"><tr>
              {['Time', 'Changed by', 'Account', 'Old role', 'Requested role', 'Confirmed role', 'Outcome'].map((h) => <th key={h} className="whitespace-nowrap p-3 font-medium">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y">
              {history.data.entries.map((entry) => <tr key={entry.id}>
                <td className="p-3 whitespace-nowrap"><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
                  {entry.finishedAt && <div className="mt-1 text-[11px] text-muted-foreground">Finished {new Date(entry.finishedAt).toLocaleString()}</div>}
                </td>
                <td className="p-3 font-mono break-all">{entry.actorId}</td>
                <td className="p-3 font-mono break-all">{entry.targetId ?? 'Not retained'}</td>
                <td className="p-3">{entry.previousRole ? roles[entry.previousRole] : 'Unknown'}</td>
                <td className="p-3">{entry.requestedRole ? roles[entry.requestedRole] : 'Not retained'}</td>
                <td className="p-3">{entry.resultingRole ? roles[entry.resultingRole] : 'Not confirmed'}</td>
                <td className="p-3 min-w-48"><Pill tone={entry.outcome === 'succeeded' ? 'good' : entry.outcome === 'denied' ? 'bad' : 'neutral'}>{outcomes[entry.outcome]}</Pill>
                  <p className="mt-1 text-[11px] text-muted-foreground">{reasons[entry.reason] ?? 'See current account permissions for the latest state.'}</p>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        <div className="flex items-center justify-end gap-3 text-[12px]">
          <span>Page {pages.length}</span>
          <button type="button" disabled={pages.length === 1 || history.isFetching} onClick={() => setPages((p) => p.slice(0, -1))} className="rounded-md border px-3 py-1.5 disabled:opacity-50">Newer</button>
          <button type="button" disabled={!history.data?.nextCursor || history.isFetching || history.isError}
            onClick={() => { const cursor = history.data?.nextCursor; if (cursor) setPages((p) => [...p, cursor]); }}
            className="rounded-md border px-3 py-1.5 disabled:opacity-50">Older</button>
        </div>
      </div>
    </section>
  );
}
