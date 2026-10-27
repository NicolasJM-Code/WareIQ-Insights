import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthSession, getSettingsAccess } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { setOwnReportsUser } from './own-reports-store';

type Access = { role: 'admin' | 'supervisor' | 'unassigned'; canReport: boolean; canAdminister: boolean };
const AccessContext = createContext<Access>({ role: 'unassigned', canReport: false, canAdminister: false });
export const useAccess = () => useContext(AccessContext);

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
        setPending(true);
        setError(false);
        try {
          await client.cancelQueries();
          client.clear();
          setOwnReportsUser(null);
          await signOut({ redirectUrl: import.meta.env.BASE_URL });
        } catch {
          setError(true);
          setPending(false);
        }
      }}>{pending ? 'Signing out…' : 'Sign out'}</button>
    {error && <span role="alert" className="text-xs text-destructive">Sign-out failed. Please retry.</span>}
  </span>;
}

// Cookie transport only; no tokens are stored or attached by application code.
export function ReportingAccess({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  const queryClient = useQueryClient();
  const { addListener } = useClerk();
  const access = useQuery({
    queryKey: ['wareiq-access', userId, sessionId],
    queryFn: ({ signal }) => getAuthSession({ signal, credentials: 'same-origin', cache: 'no-store' }),
    enabled: isLoaded && !!isSignedIn,
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
  });
  useEffect(() => {
    let previous = userId;
    return addListener(({ user }) => {
      const next = user?.id ?? null;
      if (next !== previous) {
        void queryClient.cancelQueries();
        queryClient.clear();
        setOwnReportsUser(null);
        previous = next;
      }
    });
  }, [addListener, queryClient, userId]);
  if (!isLoaded) return <AccessMessage title="Loading session"><p>Please wait…</p></AccessMessage>;
  if (!isSignedIn) return <AccessMessage title="Sign-in required"><p>Sign in to use warehouse reporting.</p><Link href="/sign-in" className="text-foreground underline">Sign in</Link></AccessMessage>;
  if (access.isPending) return <AccessMessage title="Checking access"><p>Verifying your reporting permissions…</p></AccessMessage>;
  if (access.isError || access.data?.userId !== userId) return <AccessMessage title="Access could not be verified">
    <p>Your session may have expired, or the permission service is unavailable. Reports and settings remain locked.</p>
    <button className="underline" onClick={() => void access.refetch()}>Retry access check</button><div><SignOutButton /></div>
  </AccessMessage>;
  if (!access.data.canReport) return <AccessMessage title="Access denied">
    <p>Your account has no reporting role. Ask the application owner to assign Supervisor or Administrator access, then retry.</p>
    <button className="underline" onClick={() => void access.refetch()}>Check access again</button><div><SignOutButton /></div>
  </AccessMessage>;
  return <AccessContext.Provider value={access.data}>
    <UserReportScope key={`${userId}:${sessionId}`} userId={userId!}>{children}</UserReportScope>
  </AccessContext.Provider>;
}

function UserReportScope({ userId, children }: { userId: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setOwnReportsUser(userId);
    setReady(true);
    return () => setOwnReportsUser(null);
  }, [userId]);
  return ready ? children : null;
}

export function AdministratorAccess({ children }: { children: ReactNode }) {
  const { canAdminister } = useAccess();
  const { userId, sessionId } = useAuth();
  const check = useQuery({
    queryKey: ['wareiq-settings-access', userId, sessionId],
    queryFn: ({ signal }) => getSettingsAccess({ signal, credentials: 'same-origin', cache: 'no-store' }),
    enabled: canAdminister,
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
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
      <div className="text-muted-foreground capitalize">{role === 'admin' ? 'Administrator' : role}</div>
    </div>
    <SignOutButton />
  </div>;
}
