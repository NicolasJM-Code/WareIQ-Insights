import { type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { UserButton } from '@clerk/react';
import { useAccess } from '@/lib/use-access';
import { SECTIONS, sectionForPath } from '@/lib/report-catalog';

export function AccessGate({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const query = useAccess();
  const access = query.data;
  if (path.startsWith('/sign-in') || path.startsWith('/sign-up')) return children;
  const panel = (title: string, body: string) => <section className="mx-auto max-w-xl rounded-md border bg-card p-8 mt-8 space-y-4">
    <h1 className="text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{body}</p>
    {access?.status !== 'signed_out' && <UserButton />}
    <Link href="/" className="block text-primary underline text-sm">Back to home</Link>
  </section>;
  if (query.isLoading || !query.isFetched) return <p role="status" className="p-8">Checking your reporting access…</p>;
  if (query.isError) return <div role="alert" className="p-8">Access could not be verified. <button onClick={() => void query.refetch()} className="underline">Retry</button></div>;
  if (!access || access.status === 'signed_out') return <section className="mx-auto max-w-2xl rounded-md border bg-card p-8 mt-8 space-y-4">
    <h1 className="font-display text-3xl font-bold">Warehouse reporting for your team</h1>
    <p className="text-muted-foreground">Sign in to WareIQ to access the reports and sites approved for your client. New accounts require administrator approval.</p>
    <Link href="/sign-in" className="inline-block bg-primary text-primary-foreground rounded px-4 py-2">Sign in</Link>
  </section>;
  if (access.platformAdmin) {
    const section = sectionForPath(path);
    if (path.includes('/own-reports') && (!section || !access.ownReportSections.includes(section.id)))
      return panel('Assign a reporting client first', 'Administrators manage all clients, but own report definitions must belong to one client. Add your verified login email as a user with a client and role in User access.');
    return children;
  }
  if (access.status === 'unassigned') return panel('Access awaiting approval', 'Your account is signed in. Ask your administrator to assign your verified email to a client, role and sites.');
  if (access.status === 'disabled') return panel('Reporting access is disabled', 'Your user account, client or assigned role is not active. Contact your administrator.');
  if (path === '/settings' || path === '/user-access') return panel('Administrator access required', 'You do not have permission to manage users or database settings.');
  const section = sectionForPath(path);
  const ownReportsAllowed = !!section && access.ownReportSections.includes(section.id);
  const allowed = section && section.defaults.some((r) => access.reportIds.includes(r.id));
  if (path.includes('/own-reports') && !ownReportsAllowed)
    return panel('Own report creation is not allowed', 'Your administrator has not enabled own reports for this section.');
  if (!section || path === '/' || path === '/dashboard' || path === section.overview) {
      if (section && path !== '/' && path !== '/dashboard' && !allowed && !ownReportsAllowed) return panel('Report access not granted', 'Your role does not include reports in this section.');
    return <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{access.clientName} · Your reports</h1>
      {access.status === 'pending_sites' && <p role="status" className="rounded border bg-accent p-4 text-sm">Your account is approved, but no imported sites are assigned yet. Report execution remains blocked until the WMS is connected and your administrator assigns sites.</p>}
      <UserButton />
      <div className="grid gap-3 sm:grid-cols-2">{SECTIONS.filter((s) => s.defaults.some((r) => access.reportIds.includes(r.id))
        || access.ownReportSections.includes(s.id)).map((s) =>
        <Link key={s.id} href={`${s.base}/reports`} className="rounded border bg-card p-4 hover:border-primary">{s.label}</Link>)}</div>
      {!access.reportIds.length && <p>No reports have been granted to your role.</p>}
    </section>;
  }
  if (!allowed && !ownReportsAllowed) return panel('Report access not granted', 'Your role does not include reports in this section.');
  if (path.includes('/reports/')) {
    const reportId = path.split('/reports/')[1]?.split('/')[0];
    if (!access.reportIds.includes(reportId)) return panel('Report access not granted', 'Your role does not include this report.');
  }
  return children;
}
