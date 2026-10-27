import { useMemo, useState } from 'react';
import type { AccessClient, AccessDirectory, AccessRole, AccessUser } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Info, MailCheck } from 'lucide-react';
import { FieldLabel, FormError, errorMessage, selectCls } from './access-ui';

type SaveFn<T> = (v: T) => Promise<unknown>;

export function ClientDialog({ open, onOpenChange, client, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; client: AccessClient | null; onSave: SaveFn<{ id?: string; name: string; active: boolean }> }) {
  const [name, setName] = useState(client?.name ?? '');
  const [active, setActive] = useState(client?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return setErr('Client name is required.');
    setBusy(true); setErr(null);
    try { await onSave({ id: client?.id, name: name.trim(), active }); onOpenChange(false); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">{client ? 'Edit client' : 'New client'}</DialogTitle>
          <DialogDescription>A client owns roles, users and its WMS-imported sites.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div><FieldLabel>Name</FieldLabel><Input data-testid="input-client-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span className="text-sm"><b>Active</b><br /><span className="text-muted-foreground">Disabling blocks every user under this client.</span></span>
            <Switch data-testid="switch-client-active" checked={active} onCheckedChange={setActive} />
          </label>
          <FormError message={err} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="button-save-client" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save client'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RoleDialog({ open, onOpenChange, role, dir, defaultClientId, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; role: AccessRole | null; dir: AccessDirectory; defaultClientId: string; onSave: SaveFn<{ id?: string; clientId: string; name: string; reportIds: string[]; canCreateOwnReports: boolean }> }) {
  const [clientId, setClientId] = useState(role?.clientId ?? defaultClientId);
  const [name, setName] = useState(role?.name ?? '');
  const [reportIds, setReportIds] = useState<string[]>(role?.reportIds ?? []);
  const [own, setOwn] = useState(role?.canCreateOwnReports ?? false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: AccessDirectory['reports'] }>();
    for (const r of dir.reports) {
      const g = m.get(r.section) ?? { name: r.sectionName, items: [] };
      g.items.push(r); m.set(r.section, g);
    }
    return [...m.entries()];
  }, [dir.reports]);
  const toggle = (id: string) => setReportIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleGroup = (ids: string[], on: boolean) => setReportIds((p) => (on ? [...new Set([...p, ...ids])] : p.filter((x) => !ids.includes(x))));
  const submit = async () => {
    if (!clientId) return setErr('Choose the client this role belongs to.');
    if (!name.trim()) return setErr('Role name is required.');
    setBusy(true); setErr(null);
    try { await onSave({ id: role?.id, clientId, name: name.trim(), reportIds, canCreateOwnReports: own }); onOpenChange(false); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{role ? 'Edit role' : 'New role'}</DialogTitle>
          <DialogDescription>Pick exactly which standard reports this role can open. Own-report creation is granted separately.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><FieldLabel>Client</FieldLabel>
              <select data-testid="select-role-client" className={selectCls} value={clientId} disabled={!!role} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Select client</option>
                {dir.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div><FieldLabel>Role name</FieldLabel><Input data-testid="input-role-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
          </div>
          <div>
            <FieldLabel hint={`${reportIds.length} of ${dir.reports.length} selected`}>Reports</FieldLabel>
            {groups.length === 0 ? <p className="text-sm text-muted-foreground">No reports available in the catalog.</p> : (
              <div className="divide-y rounded-md border">
                {groups.map(([sec, g]) => {
                  const ids = g.items.map((r) => r.id);
                  const all = ids.every((i) => reportIds.includes(i));
                  return (
                    <div key={sec} className="p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-mono text-[11px] uppercase tracking-wider">{g.name}</span>
                        <button type="button" data-testid={`button-toggle-section-${sec}`} className="text-xs text-primary hover:underline" onClick={() => toggleGroup(ids, !all)}>{all ? 'Clear' : 'Select all'}</button>
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {g.items.map((r) => (
                          <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                            <Checkbox data-testid={`checkbox-report-${r.id}`} checked={reportIds.includes(r.id)} onCheckedChange={() => toggle(r.id)} />
                            {r.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <label className="flex items-center justify-between rounded-md border border-accent-foreground/20 bg-accent/40 p-3">
            <span className="text-sm"><b>Can create own reports</b><br /><span className="text-muted-foreground">Lets members build private reports from permitted datasets.</span></span>
            <Switch data-testid="switch-role-own" checked={own} onCheckedChange={setOwn} />
          </label>
          <FormError message={err} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="button-save-role" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save role'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UserDialog({ open, onOpenChange, user, dir, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; user: AccessUser | null; dir: AccessDirectory; onSave: SaveFn<{ id?: string; email: string; name: string; clientId: string; roleId: string; siteIds: string[]; primarySiteId: string | null; active: boolean }> }) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [clientId, setClientId] = useState(user?.clientId ?? '');
  const [roleId, setRoleId] = useState(user?.roleId ?? '');
  const availableAssigned = (user?.siteIds ?? []).filter((id) =>
    dir.sites.some((site) => site.id === id && site.clientId === user?.clientId && site.active));
  const removedAssignments = (user?.siteIds.length ?? 0) - availableAssigned.length;
  const [siteIds, setSiteIds] = useState<string[]>(availableAssigned);
  const [primary, setPrimary] = useState<string | null>(
    user?.primarySiteId && availableAssigned.includes(user.primarySiteId) ? user.primarySiteId : null);
  const [active, setActive] = useState(user?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = dir.roles.filter((r) => r.clientId === clientId);
  const sites = dir.sites.filter((s) => s.clientId === clientId && s.active);
  const changeClient = (id: string) => { setClientId(id); setRoleId(''); setSiteIds([]); setPrimary(null); };
  const toggleSite = (id: string) => setSiteIds((p) => {
    const next = p.includes(id) ? p.filter((x) => x !== id) : [...p, id];
    if (primary && !next.includes(primary)) setPrimary(null);
    return next;
  });
  const submit = async () => {
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return setErr('Enter a valid email address.');
    if (!name.trim()) return setErr('Name is required.');
    if (!clientId) return setErr('Choose a client.');
    if (!roleId) return setErr('Choose a role from the selected client.');
    if (siteIds.length > 0 && !primary) return setErr('Choose a primary warehouse from the selected warehouses.');
    if (primary && !siteIds.includes(primary)) return setErr('Primary warehouse must be one of the selected warehouses.');
    setBusy(true); setErr(null);
    try { await onSave({ id: user?.id, email: em, name: name.trim(), clientId, roleId, siteIds, primarySiteId: primary, active }); onOpenChange(false); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{user ? 'Edit user access' : 'Approve user'}</DialogTitle>
          <DialogDescription>Approve a login email. Access applies once that person signs in with the same verified address.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2 rounded-md border border-primary/25 bg-primary/5 p-3 text-xs text-foreground/80">
            <MailCheck className="h-4 w-4 shrink-0 text-primary" />
            <span>No invitation email is sent. Tell the person to sign up or sign in normally and verify this email; the server then matches them to this approval.</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><FieldLabel>Verified login email</FieldLabel><Input data-testid="input-user-email" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div><FieldLabel>Display name</FieldLabel><Input data-testid="input-user-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><FieldLabel>Client</FieldLabel>
              <select data-testid="select-user-client" className={selectCls} value={clientId} onChange={(e) => changeClient(e.target.value)}>
                <option value="">Select client</option>
                {dir.clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (disabled)'}</option>)}
              </select>
            </div>
            <div><FieldLabel>Role</FieldLabel>
              <select data-testid="select-user-role" className={selectCls} value={roleId} disabled={!clientId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">{!clientId ? 'Choose client first' : roles.length ? 'Select role' : 'No roles for this client'}</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <FieldLabel hint="Active warehouses of this client">Warehouses</FieldLabel>
            {removedAssignments > 0 && clientId === user?.clientId && (
              <p role="status" className="mb-2 rounded border border-amber-400/40 bg-amber-50 p-2 text-xs text-amber-900">
                {removedAssignments} inactive or unavailable warehouse assignment(s) will be removed when you save. Choose a primary warehouse from the remaining selections.
              </p>
            )}
            {!clientId ? <p className="text-sm text-muted-foreground">Choose a client to see its warehouses.</p> : sites.length === 0 ? (
              <div className="flex gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                <Info className="h-4 w-4 shrink-0" />
                <span>This client has no active warehouses yet. Add one on the Warehouses tab, or save this user now as pending; their reports stay blocked until a warehouse is assigned.</span>
              </div>
            ) : (
              <div className="divide-y rounded-md border">
                {sites.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Checkbox data-testid={`checkbox-site-${s.id}`} checked={siteIds.includes(s.id)} onCheckedChange={() => toggleSite(s.id)} />
                    <span className="flex-1">{s.name} <span className="font-mono text-[11px] text-muted-foreground">{s.sourceId}</span>{!s.active && <span className="ml-2 text-xs text-muted-foreground">inactive</span>}</span>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input type="radio" name="primary" data-testid={`radio-primary-${s.id}`} disabled={!siteIds.includes(s.id)} checked={primary === s.id} onChange={() => setPrimary(s.id)} /> Primary
                    </label>
                  </div>
                ))}
              </div>
            )}
            {clientId && siteIds.length === 0 && sites.length > 0 && <p className="mt-1.5 text-xs text-muted-foreground">Saved without warehouses, this user will be pending and blocked from reports. Users never see unassigned warehouses.</p>}
          </div>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span className="text-sm"><b>Active</b><br /><span className="text-muted-foreground">Disabled users cannot open any report.</span></span>
            <Switch data-testid="switch-user-active" checked={active} onCheckedChange={setActive} />
          </label>
          <FormError message={err} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="button-save-user" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save user'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
