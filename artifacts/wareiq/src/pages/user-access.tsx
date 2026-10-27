import { useState, type ReactNode } from 'react';
import { notificationDescription } from '@/lib/access-notification';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetAccessAdminQueryKey,
  getGetAccessSessionQueryKey,
  useDeleteAccessEntry,
  useGetAccessAdmin,
  useGetAccessSession,
  useSaveAccessClient,
  useRequestAccessClientLogoUpload,
  useSaveAccessClientLogo,
  useSaveAccessRole,
  useSaveAccessUser,
  useSaveAccessWarehouse,
} from '@workspace/api-client-react';
import type { AccessClient, AccessClientLogoUploadInput, AccessDirectory, AccessRole, AccessSite, AccessUser } from '@workspace/api-client-react';
import { Building2, KeyRound, MailCheck, MapPin, Pencil, Warehouse, Plus, Power, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { SkeletonBlock, StatePanel, StatusPill, FormError, errorMessage } from '@/components/access/access-ui';
import { ClientDialog, RoleDialog, UserDialog, type ClientDetailsInput } from '@/components/access/access-dialogs';
import { WarehouseDialog, type WarehouseInput } from '@/components/access/warehouse-dialog';

type Tab = 'clients' | 'sites' | 'roles' | 'users';
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
  const requestClientLogoUpload = useRequestAccessClientLogoUpload();
  const saveClientLogo = useSaveAccessClientLogo();
  const saveRole = useSaveAccessRole();
  const saveUser = useSaveAccessUser();
  const saveWarehouse = useSaveAccessWarehouse();
  const del = useDeleteAccessEntry();
  const [tab, setTab] = useState<Tab>('clients');
  const [whDlg, setWhDlg] = useState<{ open: boolean; item: AccessSite | null; k: number }>({ open: false, item: null, k: 0 });
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
  const siteOf = (id: string) => dir.sites.find((x) => x.id === id);
  const siteName = (id: string) => siteOf(id)?.name ?? id;
  const reportName = (id: string) => dir.reports.find((r) => r.id === id)?.name ?? id;
  const byClient = <T extends { clientId: string }>(arr: T[]) => (clientFilter ? arr.filter((x) => x.clientId === clientFilter) : arr);
  const pendingUsers = dir.users.filter((u) => u.active && u.siteIds.length === 0).length;

  const doSaveClient = async (v: ClientDetailsInput) => {
    const saved = await saveClient.mutateAsync({ data: v });
    await refresh();
    return saved;
  };
  const doUploadClientLogo = async (clientId: string, file: File) => {
    const contentType = file.type as AccessClientLogoUploadInput['contentType'];
    const request = await requestClientLogoUpload.mutateAsync({
      clientId,
      data: { name: file.name, size: file.size, contentType },
    });
    const uploaded = await fetch(request.uploadURL, {
      method: 'PUT', body: file, headers: { 'Content-Type': contentType }, credentials: 'omit',
    });
    if (!uploaded.ok) throw new Error('The logo could not be uploaded. Please try again.');
    const saved = await saveClientLogo.mutateAsync({ clientId, data: { objectPath: request.objectPath } });
    await refresh();
    return saved;
  };
  const doRemoveClientLogo = async (clientId: string) => {
    const saved = await saveClientLogo.mutateAsync({ clientId, data: { objectPath: null } });
    await refresh();
    return saved;
  };
  const clientInput = (c: AccessClient, active = c.active): ClientDetailsInput => ({
    id: c.id, name: c.name, companyNumber: c.companyNumber,
    addressLine1: c.addressLine1, addressLine2: c.addressLine2,
    city: c.city, region: c.region, postalCode: c.postalCode, country: c.country, active,
  });
  const doSaveRole = async (v: { id?: string; clientId: string; name: string; reportIds: string[]; canCreateOwnReports: boolean }) => {
    const saved = await saveRole.mutateAsync({ data: v });
    await refresh();
    toast({ title: 'Role saved', description: notificationDescription(saved.notification) });
  };
  const doSaveUser = async (v: Parameters<typeof saveUser.mutateAsync>[0]['data']) => {
    const saved = await saveUser.mutateAsync({ data: v });
    await refresh();
    toast({ title: 'User access saved', description: notificationDescription(saved.notification) });
  };

  const doSaveWarehouse = async (v: WarehouseInput) => { await saveWarehouse.mutateAsync({ data: v }); await refresh(); toast({ title: v.id ? 'Warehouse saved' : 'Warehouse added' }); };
  const openWarehouse = (item: AccessSite | null) => setWhDlg((d) => ({ open: true, item, k: d.k + 1 }));
  const showClientWarehouses = (id: string) => { setClientFilter(id); setTab('sites'); };
  const noWarehouses = dir.sites.length === 0;
  const step = dir.clients.length === 0 ? 1 : noWarehouses ? 2 : dir.roles.length === 0 ? 3 : dir.users.length === 0 ? 4 : 5;

  const toggleClient = async (c: AccessClient) => {
    try { await doSaveClient(clientInput(c, !c.active)); toast({ title: 'Client saved' }); } catch (e) { toast({ title: 'Could not update client', description: errorMessage(e), variant: 'destructive' }); }
  };
  const toggleUser = async (u: AccessUser) => {
    const siteIds = u.siteIds.filter((id) => dir.sites.some((site) => site.id === id && site.clientId === u.clientId && site.active));
    const primarySiteId = u.primarySiteId && siteIds.includes(u.primarySiteId) ? u.primarySiteId : siteIds[0] ?? null;
    try { await doSaveUser({ id: u.id, email: u.email, name: u.name, clientId: u.clientId, roleId: u.roleId, siteIds, primarySiteId, active: !u.active }); }
    catch (e) { toast({ title: 'Could not update user', description: errorMessage(e), variant: 'destructive' }); }
  };
  const confirmDelete = async () => {
    if (!pendingDel) return;
    setDelErr(null);
    try { await del.mutateAsync({ entity: pendingDel.entity, id: pendingDel.id }); await refresh(); toast({ title: `${pendingDel.label} deleted` }); setPendingDel(null); }
    catch (e) { setDelErr(errorMessage(e)); }
  };

  const tabs: { id: Tab; label: string; count: number; icon: typeof Users }[] = [
    { id: 'clients', label: 'Clients', count: dir.clients.length, icon: Building2 },
    { id: 'sites', label: 'Warehouses', count: dir.sites.length, icon: Warehouse },
    { id: 'roles', label: 'Roles', count: dir.roles.length, icon: KeyRound },
    { id: 'users', label: 'Users', count: dir.users.length, icon: Users },
  ];
  const noClients = dir.clients.length === 0;

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">Reporting approvals, role changes and revocations queue an email from WareIQ. Email delivery may be delayed or fail independently; saved access changes apply immediately.</p>
      <header className="rise flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Administration / Access control</p>
          <h1 className="font-display text-3xl font-bold md:text-4xl">User access</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">Set up each client, its warehouses, then decide who sees which reports at which assigned warehouses.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="button-new-client" variant="outline" onClick={() => setClientDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Client</Button>
          <Button data-testid="button-new-warehouse" variant="outline" disabled={noClients} onClick={() => openWarehouse(null)}><Plus className="mr-1.5 h-4 w-4" />Warehouse</Button>
          <Button data-testid="button-new-role" variant="outline" disabled={noClients} onClick={() => setRoleDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Role</Button>
          <Button data-testid="button-new-user" disabled={noClients} onClick={() => setUserDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />Approve user</Button>
        </div>
      </header>

      <ol className="rise grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-4" aria-label="Setup order" data-testid="list-setup-steps">
        {(['Client', 'Warehouses', 'Roles', 'Users'] as const).map((l, i) => {
          const n = i + 1; const done = step > n; const cur = step === n;
          return (
            <li key={l} className={`flex items-center gap-3 bg-card px-4 py-3 ${cur ? 'bg-accent/40' : ''}`} aria-current={cur ? 'step' : undefined}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-sm font-mono text-xs font-bold ${done ? 'bg-primary text-primary-foreground' : cur ? 'hazard text-transparent' : 'bg-muted text-muted-foreground'}`}>{cur ? <span className="rounded-sm bg-card px-1 text-foreground">{n}</span> : n}</span>
              <span className="text-sm"><span className="font-semibold">{l}</span><span className="block text-[11px] text-muted-foreground">{done ? 'Done' : cur ? 'Next step' : 'Later'}</span></span>
            </li>
          );
        })}
      </ol>

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
            <p className="font-semibold">Only assigned warehouses are visible</p>
            <p className="mt-1 text-muted-foreground">Warehouses are configured here and stored in WareIQ only; they are not imported or verified WMS records and no WMS data is changed. Users never inherit every client warehouse. Without an assignment they stay pending and reports are blocked.{pendingUsers > 0 && <> <b className="text-foreground tnum" data-testid="text-pending-count">{pendingUsers}</b> pending now.</>}</p>
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
          dir.clients.length === 0 ? <Empty title="No clients yet" body="Step 1. Create your first client, then add its warehouses, roles and users." action={<Button data-testid="button-empty-client" onClick={() => setClientDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />New client</Button>} /> : (
            <Table head={['Client details', 'Warehouses', 'Roles', 'Users', 'Status', '']}>
              {dir.clients.map((c) => (
                <tr key={c.id} data-testid={`row-client-${c.id}`} className="border-t hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {c.logoPath && <img data-testid={`img-client-logo-${c.id}`} src={`/api/access/clients/${c.id}/logo?v=${encodeURIComponent(c.logoPath)}`} alt="" className="h-10 w-14 rounded border bg-white object-contain p-1" />}
                      <div><p className="font-medium">{c.name}</p>
                        {c.companyNumber && <p className="text-xs text-muted-foreground">Company no. {c.companyNumber}</p>}
                        {[c.addressLine1, c.addressLine2, [c.city, c.region, c.postalCode].filter(Boolean).join(', '), c.country].filter(Boolean).map((line, index) => <p key={index} className="text-xs text-muted-foreground">{line}</p>)}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2"><button data-testid={`button-client-warehouses-${c.id}`} onClick={() => showClientWarehouses(c.id)} className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-medium transition-colors hover:border-primary/50 hover:text-primary"><Warehouse className="h-3.5 w-3.5" />Warehouses<span className="tnum font-mono text-[10px] text-muted-foreground">{dir.sites.filter((x) => x.clientId === c.id).length}</span></button></td>
                  <Num v={dir.roles.filter((r) => r.clientId === c.id).length} />
                  <Num v={dir.users.filter((u) => u.clientId === c.id).length} />
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
            <Table head={['User', 'Client / role', 'Warehouses', 'Status', '']}>
              {byClient(dir.users).map((u) => (
                <tr key={u.id} data-testid={`row-user-${u.id}`} className="border-t align-top hover:bg-muted/40">
                  <td className="px-4 py-3"><p className="font-medium">{u.name}</p><p className="font-mono text-xs text-muted-foreground" data-testid={`text-user-email-${u.id}`}>{u.email}</p></td>
                  <td className="px-4 py-3"><p>{clientName(u.clientId)}</p><p className="text-xs text-muted-foreground">{roleName(u.roleId)}</p></td>
                  <td className="px-4 py-3 text-xs">
                    {u.siteIds.length === 0 ? <span className="inline-flex items-center gap-1 rounded-sm border border-dashed border-accent-foreground/40 px-1.5 py-0.5 font-mono uppercase text-accent-foreground" data-testid={`status-pending-${u.id}`}>Pending warehouses</span> : (
                      <div className="flex flex-wrap gap-1">{u.siteIds.map((id) => { const off = siteOf(id)?.active === false; return <span key={id} data-testid={`badge-user-site-${u.id}-${id}`} title={off ? 'Inactive: grants no access' : id === u.primarySiteId ? 'Primary warehouse' : undefined} className={`rounded-sm px-1.5 py-0.5 ${off ? 'border border-dashed text-muted-foreground line-through' : id === u.primarySiteId ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{siteName(id)}{off && <span className="ml-1 font-mono text-[9px] uppercase no-underline">inactive</span>}</span>; })}</div>
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
          noClients ? <Empty title="Create a client first" body="Every warehouse belongs to exactly one client. Add the client in step 1, then configure its warehouses here." action={<Button data-testid="button-empty-warehouse-client" onClick={() => setClientDlg((d) => ({ open: true, item: null, k: d.k + 1 }))}><Plus className="mr-1.5 h-4 w-4" />New client</Button>} /> :
          byClient(dir.sites).length === 0 ? <Empty title={clientFilter ? `No warehouses for ${clientName(clientFilter)}` : 'No warehouses yet'} body="Step 2. Add each warehouse this client operates, with its WMS warehouse code. Configuration is stored in WareIQ only and does not change WMS data. Users saved before a warehouse is assigned remain pending." action={<Button data-testid="button-empty-warehouse" onClick={() => openWarehouse(null)}><Plus className="mr-1.5 h-4 w-4" />Add warehouse</Button>} /> : (
            <Table head={['Warehouse', 'WMS code', 'Client', 'Assigned users', 'Status', '']}>
              {byClient(dir.sites).map((x) => (
                <tr key={x.id} data-testid={`row-site-${x.id}`} className="border-t hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <p className="font-medium">{x.name}</p>
                    {[x.addressLine1, x.addressLine2, [x.city, x.region, x.postalCode].filter(Boolean).join(', '), x.country, x.contactPhone].filter(Boolean).map((line, index) => <p key={index} className="text-xs text-muted-foreground">{line}</p>)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{x.sourceId}</td>
                  <td className="px-4 py-3 text-muted-foreground">{clientName(x.clientId)}</td>
                  <Num v={dir.users.filter((u) => u.siteIds.includes(x.id)).length} />
                  <td className="px-4 py-3"><StatusPill active={x.active} /></td>
                  <Actions>
                    <IconBtn id={`button-edit-site-${x.id}`} label="Edit or change active state" onClick={() => openWarehouse(x)}><Pencil className="h-4 w-4" /></IconBtn>
                  </Actions>
                </tr>
              ))}
            </Table>
          )
        )}
      </div>

      {clientDlg.open && <ClientDialog key={`c${clientDlg.k}`} open onOpenChange={(o) => setClientDlg((d) => ({ ...d, open: o }))} client={clientDlg.item}
        onSave={doSaveClient} onUploadLogo={doUploadClientLogo} onRemoveLogo={doRemoveClientLogo}
        onComplete={() => toast({ title: 'Client saved' })} />}
      {whDlg.open && <WarehouseDialog key={`w${whDlg.k}`} open onOpenChange={(o) => setWhDlg((d) => ({ ...d, open: o }))} warehouse={whDlg.item} dir={dir} defaultClientId={clientFilter} onSave={doSaveWarehouse} />}
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
