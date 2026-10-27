import { useState } from 'react';
import type { AccessDirectory, AccessSite } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Lock } from 'lucide-react';
import { FieldLabel, FormError, errorMessage, selectCls } from './access-ui';

export type WarehouseInput = {
  id?: string;
  clientId: string;
  name: string;
  sourceId: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  contactPhone: string;
  active: boolean;
};

export function WarehouseDialog({ open, onOpenChange, warehouse, dir, defaultClientId, onSave }: {
  open: boolean; onOpenChange: (o: boolean) => void; warehouse: AccessSite | null; dir: AccessDirectory; defaultClientId: string; onSave: (v: WarehouseInput) => Promise<unknown>;
}) {
  const editing = !!warehouse;
  const [clientId, setClientId] = useState(warehouse?.clientId ?? (dir.clients.some((c) => c.id === defaultClientId) ? defaultClientId : ''));
  const [name, setName] = useState(warehouse?.name ?? '');
  const [sourceId, setSourceId] = useState(warehouse?.sourceId ?? '');
  const [addressLine1, setAddressLine1] = useState(warehouse?.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(warehouse?.addressLine2 ?? '');
  const [city, setCity] = useState(warehouse?.city ?? '');
  const [region, setRegion] = useState(warehouse?.region ?? '');
  const [postalCode, setPostalCode] = useState(warehouse?.postalCode ?? '');
  const [country, setCountry] = useState(warehouse?.country ?? '');
  const [contactPhone, setContactPhone] = useState(warehouse?.contactPhone ?? '');
  const [active, setActive] = useState(warehouse?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const assigned = warehouse ? dir.users.filter((u) => u.siteIds.includes(warehouse.id)).length : 0;
  const deactivating = editing && warehouse!.active && !active;
  const clientName = dir.clients.find((c) => c.id === clientId)?.name;

  const submit = async () => {
    if (!clientId) return setErr('Choose the client that owns this warehouse.');
    if (!name.trim()) return setErr('Warehouse name is required.');
    if (!sourceId.trim()) return setErr('WMS warehouse code is required.');
    setBusy(true); setErr(null);
    try {
      await onSave(editing
        ? { id: warehouse!.id, clientId: warehouse!.clientId, sourceId: warehouse!.sourceId, name: name.trim(),
          addressLine1: addressLine1.trim(), addressLine2: addressLine2.trim(), city: city.trim(), region: region.trim(),
          postalCode: postalCode.trim(), country: country.trim(), contactPhone: contactPhone.trim(), active }
        : { clientId, name: name.trim(), sourceId: sourceId.trim(),
          addressLine1: addressLine1.trim(), addressLine2: addressLine2.trim(), city: city.trim(), region: region.trim(),
          postalCode: postalCode.trim(), country: country.trim(), contactPhone: contactPhone.trim(), active });
      onOpenChange(false);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{editing ? 'Edit warehouse' : 'Add warehouse'}</DialogTitle>
          <DialogDescription>Warehouses belong to exactly one client. Users only see warehouses explicitly assigned to them.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <FieldLabel hint={editing ? 'Locked after creation' : 'Required'}>Client</FieldLabel>
            {editing ? (
              <div className="flex h-9 items-center gap-2 rounded-md border border-dashed bg-muted/40 px-2 text-sm" data-testid="text-warehouse-client"><Lock className="h-3.5 w-3.5 text-muted-foreground" />{clientName ?? 'Unknown client'}</div>
            ) : (
              <select data-testid="select-warehouse-client" className={selectCls} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Select client</option>
                {dir.clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (disabled)'}</option>)}
              </select>
            )}
          </div>
          <div><FieldLabel>Warehouse name</FieldLabel><Input data-testid="input-warehouse-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Daventry DC2" /></div>
          <div>
            <FieldLabel hint={editing ? 'Locked after creation' : 'As used in the WMS'}>WMS warehouse code / source ID</FieldLabel>
            {editing ? (
              <div className="flex h-9 items-center gap-2 rounded-md border border-dashed bg-muted/40 px-2 font-mono text-sm" data-testid="text-warehouse-source"><Lock className="h-3.5 w-3.5 text-muted-foreground" />{warehouse!.sourceId}</div>
            ) : (
              <Input data-testid="input-warehouse-source" className="font-mono" maxLength={100} value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder="DAV02" />
            )}
            <p className="mt-1.5 text-xs text-muted-foreground">Stored in WareIQ only. This code is not verified against the WMS and no WMS data is changed.</p>
          </div>
          <section className="space-y-3 rounded-md border p-3" aria-label="Warehouse address and contact">
            <FieldLabel>Warehouse address and contact</FieldLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><FieldLabel>Address line 1</FieldLabel><Input data-testid="input-warehouse-address-1" maxLength={200} value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} /></div>
              <div className="sm:col-span-2"><FieldLabel>Address line 2</FieldLabel><Input data-testid="input-warehouse-address-2" maxLength={200} value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} /></div>
              <div><FieldLabel>City / town</FieldLabel><Input data-testid="input-warehouse-city" maxLength={100} value={city} onChange={(e) => setCity(e.target.value)} /></div>
              <div><FieldLabel>State / province / region</FieldLabel><Input data-testid="input-warehouse-region" maxLength={100} value={region} onChange={(e) => setRegion(e.target.value)} /></div>
              <div><FieldLabel>Postal code</FieldLabel><Input data-testid="input-warehouse-postal-code" maxLength={32} value={postalCode} onChange={(e) => setPostalCode(e.target.value)} /></div>
              <div><FieldLabel>Country</FieldLabel><Input data-testid="input-warehouse-country" maxLength={100} value={country} onChange={(e) => setCountry(e.target.value)} /></div>
              <div><FieldLabel>Contact phone</FieldLabel><Input data-testid="input-warehouse-phone" type="tel" maxLength={40} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /></div>
            </div>
          </section>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span className="text-sm"><span className="font-medium">Active</span><span className="block text-xs text-muted-foreground">Inactive warehouses cannot be assigned and grant no access.</span></span>
            <Switch data-testid="switch-warehouse-active" checked={active} onCheckedChange={setActive} />
          </label>
          {deactivating && (
            <div role="alert" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="text-deactivate-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{assigned > 0 ? <><b className="tnum">{assigned}</b> assigned {assigned === 1 ? 'user' : 'users'} will immediately lose access to this warehouse.</> : 'No users are assigned, but nobody can be granted this warehouse while it is inactive.'} The server filters inactive warehouses from every session.</span>
            </div>
          )}
          <FormError message={err} />
        </div>
        <DialogFooter>
          <Button variant="outline" data-testid="button-cancel-warehouse" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="button-save-warehouse" disabled={busy} variant={deactivating ? 'destructive' : 'default'} onClick={() => void submit()}>{busy ? 'Saving…' : deactivating ? 'Deactivate warehouse' : editing ? 'Save warehouse' : 'Add warehouse'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
