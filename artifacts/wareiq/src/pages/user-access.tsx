import { useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetAccessAdminQueryKey,
  getGetAccessSessionQueryKey,
  useDeleteAccessEntry,
  useGetAccessAdmin,
  useGetAccessSession,
  useSaveAccessClient,
  useSaveAccessRole,
  useSaveAccessUser,
} from '@workspace/api-client-react';
import type { AccessClient, AccessDirectory, AccessRole, AccessUser } from '@workspace/api-client-react';
import { Building2, KeyRound, MailCheck, MapPin, Pencil, Plus, Power, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { SkeletonBlock, StatePanel, StatusPill, FormError, errorMessage } from '@/components/access/access-ui';
import { ClientDialog, RoleDialog, UserDialog } from '@/components/access/access-dialogs';

type Tab = 'users' | 'roles' | 'clients' | 'sites';
type Del = { entity: 'clients' | 'roles' | 'users'; id: string; label: string };

export default function UserAccess() {
  const session = useGetAccessSession({ query: { queryKey: getGetAccessSessionQueryKey() } });
  const admin = useGetAccessAdmin({ query: { queryKey: getGetAccessAdminQueryKey(), enabled: session.data?.platformAdmin === true } });

  if (session.isLoading) return <Page><SkeletonBlock /></Page>;
  if (session.isError) return <Page><StatePanel title="Could not check your access" body={errorMessage(session.error)} onRetry={() => session.refetch()} /></Page>;
  const s = session.data;
  if (!s || s.status === 'signed_out') return <Page><StatePanel title="Sign in required" body="User access management is available to signed-in WareIQ administrators." action={<Link href="/sign-in" data-testid="link-sign-in" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Sign in</Link>} /></Page>;
  if (!s.platformAdmin) return <Page><StatePanel tone="warn" title="Administrators only" body="Your account does not have permission to manage clients, roles or users. Ask a WareIQ administrator if you need changes to your access." /></Page>;
  if (admin.isLoading) return <Page><SkeletonBlock /></Page>;
  if (admin.isError || !admin.data) return <Page><StatePanel title="Could not load the access directory" body={admin.isError ? errorMessage(admin.error) : 'No data returned.'} onRetry={() => admin.refetch()} /></Page>;
  return <Page><Directory dir={admin.data} /></Page>;
}

function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</div>;
}

function Directory({ dir }: { dir: AccessDirectory }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const saveClient = useSaveAccessClient();
  const saveRole = useSaveAccessRole();
  const saveUser = useSaveAccessUser();
  const del = useDeleteAccessEntry();
  const [tab, setTab] = useState<Tab>('users');
  const [clientFilter, setClientFilter] = useState('');
  const [clientDlg, setClientDlg] = useState<{ open: boolean; item: AccessClient | null; k: number }>({ open: false, item: null, k: 0 });
  const [roleDlg, setRoleDlg] = useState<{ open: boolean; item: AccessRole | null; k: number }>({ open: false, item: null, k: 0 });
  const [userDlg, setUserDlg] = useState<{ open: boolean; item: AccessUser | null; k: number }>({ open: false, item: null, k: 0 });
  const [pendingDel, setPendingDel] = useState<Del | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getGetAccessAdminQueryKey() }),
      qc.invalidateQueries({ queryKey: getGetAccessSessionQueryKey() }),
    ]);
  };
  const clientName = (id: string) => dir.clients.find((c) => c.id === id)?.name ?? 'Unknown client';
  const roleName = (id: string) => dir.roles.find((r) => r.id === id)?.name ?? 'Unknown role';
  const siteName = (id: string) => dir.sites.find((x) => x.id === id)?.name ?? id;
  const reportName = (id: string) => dir.reports.find((r) => r.id === id)?.name ?? id;
  const byClient = <T extends { clientId: string }>(arr: T[]) => (clientFilter ? arr.filter((x) => x.clientId === clientFilter) : arr);
  const pendingUsers = dir.users.filter((u) => u.active && u.siteIds.length === 0).length;

  const doSaveClient = async (v: { id?: string; name: string; active: boolean }) => { await saveClient.mutateAsync({ data: v }); await refresh(); toast({ title: 'Client saved' }); };
  const doSaveRole = async (v: { id?: string; clientId: string; name: string; reportIds: string[]; canCreateOwnReports: boolean }) => { await saveRole.mutateAsync({ data: v }); await refresh(); toast({ title: 'Role saved' }); };
  const doSaveUser = async (v: Parameters<typeof saveUser.mutateAsync>[0]['data']) => { await saveUser.mutateAsync({ data: v }); await refresh(); toast({ title: 'User access saved' }); };

  const toggleClient = async (c: AccessClient) => {
    try { await doSaveClient({ id: c.id, name: c.name, active: !c.active }); } catch (e) { toast({ title: 'Could not update client', description: errorMessage(e), variant: 'destructive' }); }
  };
  const toggleUser = async (u: AccessUser) => {
    try { await doSaveUser({ id: u.id, email: u.email, name: u.name, clientId: u.clientId, roleId: u.roleId, siteIds: u.siteIds, primarySiteId: u.primarySiteId, active: !u.active }); }
    catch (e) { toast({ title: 'Could not update user', description: errorMessage(e), variant: 'destructive' }); }
  };
  const confirmDelete = async () => {
    if (!pendingDel) return;
    setDelErr(null);
    try { await del.mutateAsync({ entity: pendingDel.entity, id: pendingDel.id }); await refresh(); toast({ title: `${pendingDel.label} deleted` }); setPendingDel(null); }
    catch (e) { setDelErr(errorMessage(e)); }
  };

  const tabs: { id: Tab; label: string; count: number; icon: typeof Users }[] = [
    { id: 'users', label: 'Users', count: dir.users.length, icon: Users },
    { id: 'roles', label: 'Roles', count: dir.roles.length, icon: KeyRound },
    { id: 'clients', label: 'Clients', count: dir.clients.length, icon: Building2 },
    { id: 'sites', label: 'Sites', count: dir.sites.length, icon: MapPin },
  ];
  const noClients = dir.clients.length === 0;

  return (
    <div className="space-y-6">
      <header className="rise flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Administration / Access control</p>
          <h1 className="font-display text-3xl font-bold md:text-4xl">User access</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">Decide who can see which reports, for which client, at which sites.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="button-new-client" variant="outline" onClick={() => setClientDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Client</Button>
          <Button data-testid="button-new-role" variant="outline" disabled={noClients} onClick={() => setRoleDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Role</Button>
          <Button data-testid="button-new-user" disabled={noClients} onClick={() => setUserDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Approve user</Button>
        </div>
      </header>

      <div className="rise grid gap-px overflow-hidden rounded-md border bg-border md:grid-cols-[1.4fr_1fr]" style={{ animationDelay: '60ms' }}>
        <div className="flex gap-3 bg-card p-4">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="text-sm">
            <p className="font-semibold">Approval by verified email, no invitations sent</p>
            <p className="mt-1 text-muted-foreground">WareIQ does not email anyone. Approve an address here, then ask the person to sign up or sign in normally and verify that email. The server matches the verified login to this approval.</p>
          </div>
        </div>
        <div className="flex gap-3 bg-card p-4">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-accent-foreground" />
          <div className="text-sm">
            <p className="font-semibold">Sites come from the WMS only</p>
            <p className="mt-1 text-muted-foreground">Users without an imported site are saved as pending. Their reports stay blocked until a WMS site is assigned.{pendingUsers > 0 && <> <b className="text-foreground tnum" data-testid="text-pending-count">{pendingUsers}</b> pending now.</>}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b sm:flex-row sm:items-end sm:justify-between">
        <nav className="-mb-px flex overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.id} data-testid={`tab-${t.id}`} onClick={() => setTab(t.id)} className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <t.icon className="h-4 w-4" />{t.label}<span className="tnum rounded-sm bg-muted px-1.5 font-mono text-[10px]">{t.count}</span>
            </button>
          ))}
        </nav>
        {tab !== 'clients' && dir.clients.length > 0 && (
          <select data-testid="select-filter-client" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="mb-2 h-8 rounded-md border border-input bg-card px-2 text-sm">
            <option value="">All clients</option>
            {dir.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>

      <div key={tab} className="rise">
        {tab === 'clients' && (
          dir.clients.length === 0 ? <Empty title="No clients yet" body="Create your first client, then add roles and approve users under it." action={<Button data-testid="button-empty-client" onClick={() => setClientDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />New client</Button>} /> : (
            <Table head={['Client', 'Roles', 'Users', 'Sites', 'Status', '']}>
              {dir.clients.map((c) => (
                <tr key={c.id} data-testid={`row-client-${c.id}`} className="border-t hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <Num v={dir.roles.filter((r) => r.clientId === c.id).length} />
                  <Num v={dir.users.filter((u) => u.clientId === c.id).length} />
                  <Num v={dir.sites.filter((x) => x.clientId === c.id).length} />
                  <td className="px-4 py-3"><StatusPill active={c.active} /></td>
                  <Actions>
                    <IconBtn id={`button-edit-client-${c.id}`} label="Edit" onClick={() => setClientDlg((d) => ({ open: true, item: c, k: d.k + 1 }))}><Pencil className="h-4 w-4" /></IconBtn>
                    <IconBtn id={`button-toggle-client-${c.id}`} label={c.active ? 'Disable' : 'Enable'} onClick={() => toggleClient(c)}><Power className="h-4 w-4" /></IconBtn>
                    <IconBtn id={`button-delete-client-${c.id}`} label="Delete" danger onClick={() => { setDelErr(null); setPendingDel({ entity: 'clients', id: c.id, label: c.name }); }}><Trash2 className="h-4 w-4" /></IconBtn>
                  </Actions>
                </tr>
              ))}
            </Table>
          )
        )}

        {tab === 'roles' && (
          byClient(dir.roles).length === 0 ? <Empty title="No roles" body={noClients ? 'Create a client first. Roles always belong to one client.' : 'Roles bundle a set of reports for one client.'} action={!noClients && <Button data-testid="button-empty-role" onClick={() => setRoleDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />New role</Button>} /> : (
            <Table head={['Role', 'Client', 'Reports', 'Own reports', '']}>
              {byClient(dir.roles).map((r) => (
                <tr key={r.id} data-testid={`row-role-${r.id}`} className="border-t align-top hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{clientName(r.clientId)}</td>
                  <td className="max-w-sm px-4 py-3">
                    <span className="tnum font-mono text-xs">{r.reportIds.length} reports</span>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.reportIds.slice(0, 6).map(reportName).join(', ')}{r.reportIds.length > 6 ? ' …' : ''}</p>
                  </td>
                  <td className="px-4 py-3 text-xs">{r.canCreateOwnReports ? <span className="rounded-sm bg-accent px-1.5 py-0.5 font-mono uppercase text-accent-foreground">Allowed</span> : <span className="text-muted-foreground">No</span>}</td>
                  <Actions>
                    <IconBtn id={`button-edit-role-${r.id}`} label="Edit" onClick={() => setRoleDlg((d) => ({ open: true, item: r, k: d.k + 1 }))}><Pencil className="h-4 w-4" /></IconBtn>
                    <IconBtn id={`button-delete-role-${r.id}`} label="Delete" danger onClick={() => { setDelErr(null); setPendingDel({ entity: 'roles', id: r.id, label: r.name }); }}><Trash2 className="h-4 w-4" /></IconBtn>
                  </Actions>
                </tr>
              ))}
            </Table>
          )
        )}

        {tab === 'users' && (
          byClient(dir.users).length === 0 ? <Empty title="No approved users" body={noClients ? 'Create a client and a role, then approve users by their login email.' : 'Approve a person by the email they will verify when signing in.'} action={!noClients && <Button data-testid="button-empty-user" onClick={() => setUserDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Approve user</Button>} /> : (
            <Table head={['User', 'Client / role', 'Sites', 'Status', '']}>
              {byClient(dir.users).map((u) => (
                <tr key={u.id} data-testid={`row-user-${u.id}`} className="border-t align-top hover:bg-muted/40">
                  <td className="px-4 py-3"><p className="font-medium">{u.name}</p><p className="font-mono text-xs text-muted-foreground" data-testid={`text-user-email-${u.id}`}>{u.email}</p></td>
                  <td className="px-4 py-3"><p>{clientName(u.clientId)}</p><p className="text-xs text-muted-foreground">{roleName(u.roleId)}</p></td>
                  <td className="px-4 py-3 text-xs">
                    {u.siteIds.length === 0 ? <span className="inline-flex items-center gap-1 rounded-sm border border-dashed border-accent-foreground/40 px-1.5 py-0.5 font-mono uppercase text-accent-foreground" data-testid={`status-pending-${u.id}`}>Pending sites</span> : (
                      <div className="flex flex-wrap gap-1">{u.siteIds.map((id) => <span key={id} className={`rounded-sm px-1.5 py-0.5 ${id === u.primarySiteId ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{siteName(id)}</span>)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3"><StatusPill active={u.active} /></td>
                  <Actions>
                    <IconBtn id={`button-edit-user-${u.id}`} label="Edit" onClick={() => setUserDlg((d) => ({ open: true, item: u, k: d.k + 1 }))}><Pencil className="h-4 w-4" /></IconBtn>
                    <IconBtn id={`button-toggle-user-${u.id}`} label={u.active ? 'Disable' : 'Enable'} onClick={() => toggleUser(u)}><Power className="h-4 w-4" /></IconBtn>
                    <IconBtn id={`button-delete-user-${u.id}`} label="Delete" danger onClick={() => { setDelErr(null); setPendingDel({ entity: 'users', id: u.id, label: u.email }); }}><Trash2 className="h-4 w-4" /></IconBtn>
                  </Actions>
                </tr>
              ))}
            </Table>
          )
        )}

        {tab === 'sites' && (
          byClient(dir.sites).length === 0 ? <Empty title="No sites imported yet" body="Sites are read-only and appear here only after they are imported from the WMS. They cannot be created in WareIQ. Users saved before then remain pending." /> : (
            <Table head={['Site', 'WMS source ID', 'Client', 'Assigned users', 'Status']}>
              {byClient(dir.sites).map((x) => (
                <tr key={x.id} data-testid={`row-site-${x.id}`} className="border-t hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{x.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">{x.sourceId}</td>
                  <td className="px-4 py-3 text-muted-foreground">{clientName(x.clientId)}</td>
                  <Num v={dir.users.filter((u) => u.siteIds.includes(x.id)).length} />
                  <td className="px-4 py-3"><StatusPill active={x.active} /></td>
                </tr>
              ))}
            </Table>
          )
        )}
      </div>

      {clientDlg.open && <ClientDialog key={`c${clientDlg.k}`} open onOpenChange={(o) => setClientDlg((d) => ({ ...d, open: o }))} client={clientDlg.item} onSave={doSaveClient} />}
      {roleDlg.open && <RoleDialog key={`r${roleDlg.k}`} open onOpenChange={(o) => setRoleDlg((d) => ({ ...d, open: o }))} role={roleDlg.item} dir={dir} defaultClientId={clientFilter} onSave={doSaveRole} />}
      {userDlg.open && <UserDialog key={`u${userDlg.k}`} open onOpenChange={(o) => setUserDlg((d) => ({ ...d, open: o }))} user={userDlg.item} dir={dir} onSave={doSaveUser} />}

      <AlertDialog open={!!pendingDel} onOpenChange={(o) => { if (!o) setPendingDel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDel?.label}?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the {pendingDel?.entity.slice(0, -1)}. If other records still depend on it, the server will refuse and explain why.</AlertDialogDescription>
          </AlertDialogHeader>
          <FormError message={delErr} />
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-delete" disabled={del.isPending} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(e) => { e.preventDefault(); void confirmDelete(); }}>{del.isPending ? 'Deleting…' : 'Delete'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full min-w-[640px] text-sm">
        <thead><tr className="bg-muted/50">{head.map((h, i) => <th key={i} className="px-4 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Num({ v }: { v: number }) { return <td className="tnum px-4 py-3 font-mono text-xs">{v}</td>; }
function Actions({ children }: { children: ReactNode }) { return <td className="px-4 py-2"><div className="flex justify-end gap-1">{children}</div></td>; }
function IconBtn({ id, label, onClick, danger, children }: { id: string; label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return <button data-testid={id} title={label} aria-label={label} onClick={onClick} className={`rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted ${danger ? 'hover:text-destructive' : 'hover:text-foreground'}`}>{children}</button>;
}
function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="grid-paper rounded-md border border-dashed px-6 py-14 text-center" data-testid="status-empty">
      <p className="font-display text-xl font-bold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
