import { useState, type ReactNode } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSettingsAccess } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { useAccess as useReportingAccess } from './use-access';

// Compatibility for the account and administrator UI. Application reporting
// approval now comes from client membership, never a global supervisor claim.
export function useAccess() {
  const query = useReportingAccess();
  // React Query retains stale data after refetch failure. It is not proof of
  // current authorization and must not keep account/admin UI unlocked.
  const session = query.isError ? undefined : query.data;
  const canAdminister = !!session?.platformAdmin;
  const canReport = canAdminister || session?.status === 'active' || session?.status === 'pending_sites';
  return { canAdminister, canReport, role: canAdminister ? 'admin' : canReport ? 'supervisor' : 'unassigned' };
}
export function AccessMessage({ title, children }: { title: string; children: ReactNode }) {
  return <main className="min-h-[100dvh] bg-background flex items-center justify-center p-6">
    <section className="w-full max-w-lg rounded-lg border bg-card p-8 space-y-4">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">WareIQ · Secure reporting</p>
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      <div className="text-sm text-muted-foreground space-y-4">{children}</div>
    </section>
  </main>;
}
export function SignOutButton() {
  const { signOut } = useClerk();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return <span className="inline-flex flex-col gap-1">
    <button type="button" disabled={pending} data-testid="button-sign-out"
      className="rounded border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
      onClick={async () => {
        setPending(true); setError(false);
        try {
          await client.cancelQueries(); client.clear();
          await signOut({ redirectUrl: import.meta.env.BASE_URL });
        } catch { setError(true); setPending(false); }
      }}>{pending ? 'Signing out…' : 'Sign out'}</button>
    {error && <span role="alert" className="text-xs text-destructive">Sign-out failed. Please retry.</span>}
  </span>;
}
export function AdministratorAccess({ children }: { children: ReactNode }) {
  const { canAdminister } = useAccess();
  const { userId, sessionId } = useAuth();
  const check = useQuery({
    queryKey: ['wareiq-settings-access', userId, sessionId],
    queryFn: ({ signal }) => getSettingsAccess({ signal, credentials: 'same-origin', cache: 'no-store' }),
    enabled: canAdminister, retry: false, staleTime: 0, refetchInterval: 30_000,
  });
  if (!canAdminister) return <section role="alert" className="rounded border bg-card p-6"><h1 className="text-xl font-bold">Access denied</h1><p className="mt-2">Only administrators can open reporting settings or database configuration.</p><Link href="/dashboard" className="mt-4 inline-block underline">Back to reporting</Link></section>;
  if (check.isPending) return <p role="status">Verifying administrator access…</p>;
  if (check.isError || !check.data?.canAdminister) return <section role="alert"><h1 className="text-xl font-bold">Settings are locked</h1><p>Administrator access could not be verified.</p><button className="underline mt-3" onClick={() => void check.refetch()}>Retry</button></section>;
  return children;
}
export function AccountSummary() {
  const { user } = useUser();
  const { role } = useAccess();
  return <div className="flex items-center gap-3 border-l pl-3">
    <div className="hidden sm:block text-xs leading-tight max-w-44">
      <div className="truncate">{user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Signed in'}</div>
      <div className="text-muted-foreground capitalize">{role === 'admin' ? 'Administrator' : role === 'supervisor' ? 'Reporting user' : 'Awaiting approval'}</div>
    </div>
    <SignOutButton />
  </div>;
}
