import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import {
  ArrowDown, ArrowLeft, ArrowUp, Copy, FilePlus2, Pencil, Play, Plus, Save, Search, Trash2, TriangleAlert, X, Table2, Check, FileBarChart,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PageHeader, DataReport } from '@/components/report-kit';
import { DemoBadge } from '@/components/shell';
import { BrowserOnlyNote, Chip, MissingPanel, btn, useCatalogCtx } from '@/components/reports-ui';
import { getDataset, getSection, type Dataset, type Section, type SectionId } from '@/lib/report-catalog';
import { columnsFor, resolveFields, scopeLabel, scopedRows, searchTextFor, slug } from '@/lib/report-engine';
import {
  NAME_MAX, createReport, deleteReport, duplicateReport, updateReport, useOwnReportsState, type OwnReport,
} from '@/lib/own-reports-store';
import { useReport, useDocTitle } from '@/lib/report-context';
import { dateTime } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useAccess } from '@/lib/use-access';
import { ReportRunControl } from '@/components/report-run-control';
import { LegacyReportImport } from '@/components/legacy-report-import';

// ---------- shared ----------
function StoreBanner() {
  const st = useOwnReportsState();
  if (st.status === 'ok') return null;
  return (
    <div className="mb-4 rounded-md border border-[hsl(4_60%_84%)] bg-[hsl(4_75%_95%)] px-3 py-2.5 text-[12px] text-[hsl(4_65%_32%)]" data-testid="status-store-error">
      <div className="flex items-start gap-2">
        <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-semibold">Own reports cannot be saved right now.</p>
          <p>{st.detail}</p>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({ report, open, onOpenChange, onDeleted }: { report: OwnReport; open: boolean; onOpenChange: (o: boolean) => void; onDeleted?: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{report.name}"?</AlertDialogTitle>
          <AlertDialogDescription>The report definition is removed from your account. This cannot be undone. No operational data is affected.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete"
            onClick={async () => {
              const r = await deleteReport(report.id);
              if (r.ok) { toast({ title: 'Report deleted', description: `"${report.name}" removed from your account.` }); onDeleted?.(); }
              else toast({ title: 'Not deleted', description: r.error, variant: 'destructive' });
            }}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

async function doDuplicate(r: OwnReport, base: string, go: (to: string) => void) {
  const res = await duplicateReport(r);
  if (res.ok && res.report) { toast({ title: 'Report duplicated', description: `Saved "${res.report.name}" in your account.` }); go(`${base}/own-reports/${res.report.id}/edit`); }
  else if (!res.ok) toast({ title: 'Not duplicated', description: res.error, variant: 'destructive' });
}

// ---------- index ----------
export function OwnReportsIndex({ sectionId }: { sectionId: SectionId }) {
  const s = getSection(sectionId)!;
  useDocTitle(`${s.label} own reports`);
  const [, go] = useLocation();
  const st = useOwnReportsState();
  const mine = useMemo(() => st.reports.filter((r) => r.section === s.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [st.reports, s.id]);
  const [del, setDel] = useState<OwnReport | null>(null);
  const canWrite = st.status === 'ok';

  return (
    <div>
      <PageHeader eyebrow={`${s.eyebrow} · Own reports`} title="Own reports" description={`Reports you build from the fields available in ${s.label.toLowerCase()}. Pick a dataset, choose and order the columns, then run or export.`}>
        <DemoBadge />
        <LegacyReportImport section={s} reports={st.reports} ready={canWrite && !st.loading} />
        {canWrite && <Link href={`${s.base}/own-reports/new`} className={btn.primary} data-testid="link-create-report"><Plus className="h-3.5 w-3.5" />New report</Link>}
      </PageHeader>
      <StoreBanner />
      <BrowserOnlyNote className="mb-4 rise" />
      {mine.length === 0 ? (
        <div className="rise rounded-md border bg-card grid md:grid-cols-[1.1fr_1fr]" data-testid="status-empty-own">
          <div className="p-6 md:p-8 border-b md:border-b-0 md:border-r grid-paper">
            <FilePlus2 className="h-7 w-7 text-primary" />
            <h2 className="font-display text-[22px] font-bold mt-3 leading-tight">No own reports in this section yet</h2>
            <p className="text-[13px] text-muted-foreground mt-1.5 max-w-sm">Start blank and pick from {s.datasets.reduce((a, d) => a + d.fields.length, 0)} available fields in this section.</p>
            {canWrite && <Link href={`${s.base}/own-reports/new`} className={cn(btn.primary, 'mt-4')} data-testid="link-create-first"><Plus className="h-3.5 w-3.5" />Build a report</Link>}
          </div>
          <div className="p-5">
            <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-muted-foreground mb-2">Section fields</div>
            <p className="text-[13px] text-muted-foreground">Choose your own fields to build a custom report. Default reports are listed by name only and will be developed later.</p>
            <ul className="space-y-1">
              {s.defaults.filter((d) => d.dataset && d.fields.length > 0).map((d) => (
                <li key={d.id}>
                  <Link href={`${s.base}/own-reports/new?from=${d.id}`} className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent/40 transition-colors" data-testid={`link-start-from-${d.id}`}>
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />{d.title}<span className="ml-auto font-mono text-[10px] text-muted-foreground">{d.fields.length} cols</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <ul className="rise rounded-md border bg-card divide-y" data-testid="list-own-reports">
          {mine.map((r) => {
            const ds = getDataset(s, r.dataset);
            const missing = ds ? resolveFields(ds, r.fields).missing.length : r.fields.length;
            return (
              <li key={r.id} className="px-4 py-3.5 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid={`card-own-report-${r.id}`}>
                <div className="min-w-0 flex-1">
                  <Link href={`${s.base}/own-reports/${r.id}`} className="font-display text-[16px] font-bold hover:text-primary transition-colors" data-testid={`link-open-own-${r.id}`}>{r.name}</Link>
                  {r.description && <p className="text-[12.5px] text-muted-foreground mt-0.5 line-clamp-1">{r.description}</p>}
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    <Chip tone="primary"><Table2 className="h-3 w-3" />{ds?.label ?? 'Unknown dataset'}</Chip>
                    <Chip>{r.fields.length} columns</Chip>
                    <Chip>Edited {dateTime(r.updatedAt)}</Chip>
                    {missing > 0 && <Chip tone="accent"><TriangleAlert className="h-3 w-3" />{missing} unavailable</Chip>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Link href={`${s.base}/own-reports/${r.id}`} className={btn.primary} data-testid={`link-run-own-${r.id}`}><Play className="h-3.5 w-3.5" />Run</Link>
                  {canWrite && <Link href={`${s.base}/own-reports/${r.id}/edit`} className={btn.icon} aria-label={`Edit ${r.name}`} data-testid={`link-edit-own-${r.id}`}><Pencil className="h-3.5 w-3.5" /></Link>}
                  <button className={btn.icon} disabled={!canWrite} onClick={() => doDuplicate(r, s.base, go)} aria-label={`Duplicate ${r.name}`} data-testid={`button-duplicate-${r.id}`}><Copy className="h-3.5 w-3.5" /></button>
                  <button className={cn(btn.icon, 'hover:text-destructive hover:border-destructive/50')} disabled={!canWrite} onClick={() => setDel(r)} aria-label={`Delete ${r.name}`} data-testid={`button-delete-${r.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {del && <DeleteDialog report={del} open onOpenChange={(o) => !o && setDel(null)} onDeleted={() => setDel(null)} />}
    </div>
  );
}

// ---------- run view ----------
export function OwnReportView({ sectionId }: { sectionId: SectionId }) {
  const access = useAccess();
  const s = getSection(sectionId)!;
  const { id } = useParams<{ id: string }>();
  const [, go] = useLocation();
  const st = useOwnReportsState();
  const r = st.reports.find((x) => x.id === id && x.section === s.id);
  useDocTitle(r ? r.name : 'Own report not found');
  const { warehouse, range } = useReport();
  const ctx = useCatalogCtx();
  const [del, setDel] = useState(false);
  const ds = r ? getDataset(s, r.dataset) : undefined;
  const resolved = useMemo(() => (ds && r ? resolveFields(ds, r.fields) : { found: [], missing: [] }), [ds, r]);
  const columns = useMemo(() => columnsFor(resolved.found), [resolved]);
  const search = useMemo(() => searchTextFor(resolved.found), [resolved]);
  const rows = useMemo(() => (ds && access.data?.platformAdmin ? scopedRows(ds, ctx, warehouse, range) : []), [ds, ctx, warehouse, range, access.data?.platformAdmin]);

  if (st.loading) return <p role="status">Loading your own report…</p>;
  if (!r) return <MissingPanel title="Own report not found" body="It may have been deleted, belong to another account, or no longer be permitted." back={`${s.base}/own-reports`} backLabel="Own reports" />;
  const canWrite = st.status === 'ok';

  return (
    <div>
      <Link href={`${s.base}/own-reports`} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground mb-2" data-testid="link-back-own"><ArrowLeft className="h-3.5 w-3.5" />Own reports</Link>
      <PageHeader eyebrow={`${s.eyebrow} · Own report · your account`} title={r.name} description={r.description || `Custom report on ${ds?.label.toLowerCase() ?? 'an unavailable dataset'}.`}>
        <DemoBadge />
        {canWrite && <Link href={`${s.base}/own-reports/${r.id}/edit`} className={btn.ghost} data-testid="link-edit-report"><Pencil className="h-3.5 w-3.5" />Edit</Link>}
        <button className={btn.ghost} disabled={!canWrite} onClick={() => doDuplicate(r, s.base, go)} data-testid="button-duplicate-report"><Copy className="h-3.5 w-3.5" />Duplicate</button>
        <button className={cn(btn.ghost, 'hover:text-destructive hover:border-destructive/50')} disabled={!canWrite} onClick={() => setDel(true)} data-testid="button-delete-report"><Trash2 className="h-3.5 w-3.5" />Delete</button>
      </PageHeader>
      <ReportRunControl reportId={r.id} />
      <StoreBanner />
      {ds && (
        <div className="rise flex flex-wrap items-center gap-1.5 mb-3">
          <Chip tone="primary"><Table2 className="h-3 w-3" />{ds.label}</Chip>
          <Chip>{scopeLabel(ds, warehouse, range)}</Chip>
          <Chip>Saved {dateTime(r.updatedAt)}</Chip>
        </div>
      )}
      {(!ds || resolved.missing.length > 0) && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-[hsl(42_70%_75%)] bg-[hsl(42_90%_92%)] px-3 py-2 text-[12px] text-[hsl(30_75%_24%)]" data-testid="status-missing-fields">
          <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {!ds ? `Dataset "${r.dataset}" is no longer available in this section. Edit the report to choose another.` : `${resolved.missing.length} saved column${resolved.missing.length === 1 ? ' is' : 's are'} no longer available and ${resolved.missing.length === 1 ? 'was' : 'were'} skipped: ${resolved.missing.join(', ')}.`}
        </div>
      )}
      {ds && resolved.found.length > 0 ? (
        <DataReport title={r.name} rows={rows} columns={columns} searchText={search} rowKey={ds.rowKey} filename={`wareiq-${s.id}-own-${slug(r.name)}`} testId="table-own-report" />
      ) : (
        <MissingPanel title="Nothing to run" body="This report has no available columns. Edit it to pick fields." back={`${s.base}/own-reports/${r.id}/edit`} backLabel="Edit report" />
      )}
      <DeleteDialog report={r} open={del} onOpenChange={setDel} onDeleted={() => go(`${s.base}/own-reports`)} />
    </div>
  );
}

// ---------- builder ----------
interface Draft { name: string; description: string; dataset: string; fields: string[] }
const same = (a: Draft, b: Draft) => a.name === b.name && a.description === b.description && a.dataset === b.dataset && a.fields.join('|') === b.fields.join('|');

export function OwnReportBuilder({ sectionId }: { sectionId: SectionId }) {
  const s = getSection(sectionId)!;
  const params = useParams<{ id?: string }>();
  const search = useSearch();
  const editing = !!params.id;
  const st = useOwnReportsState();
  const existing = editing ? st.reports.find((x) => x.id === params.id && x.section === s.id) : undefined;
  const fromId = new URLSearchParams(search).get('from');
  const fromDef = !editing && fromId ? s.defaults.find((d) => d.id === fromId && d.dataset && d.fields.length > 0) : undefined;

  const initial = useMemo<Draft>(() => {
    if (existing) return { name: existing.name, description: existing.description, dataset: existing.dataset, fields: existing.fields };
    if (fromDef) return { name: `${fromDef.title} (custom)`, description: fromDef.description, dataset: fromDef.dataset, fields: fromDef.fields };
    return { name: '', description: '', dataset: s.datasets[0].id, fields: [] };
  }, [existing?.id, fromDef?.id, s.id]);

  useDocTitle(editing ? `Edit ${existing?.name ?? 'report'}` : 'New own report');
  if (st.loading) return <p role="status">Loading your report definition…</p>;
  if (editing && !existing) return <MissingPanel title="Own report not found" body="It may have been deleted or belong to another account." back={`${s.base}/own-reports`} backLabel="Own reports" />;
  return <Builder key={`${params.id ?? 'new'}-${fromDef?.id ?? ''}`} s={s} initial={initial} existing={existing} fromTitle={fromDef?.title} fromId={fromDef?.id} unknownFrom={!!fromId && !fromDef && !editing} />;
}

function Builder({ s, initial, existing, fromTitle, fromId, unknownFrom }: { s: Section; initial: Draft; existing?: OwnReport; fromTitle?: string; fromId?: string; unknownFrom: boolean }) {
  const access = useAccess();
  const [saving, setSaving] = useState(false);
  const [, go] = useLocation();
  const st = useOwnReportsState();
  const { warehouse, range } = useReport();
  const ctx = useCatalogCtx();
  const [d, setD] = useState<Draft>(initial);
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDs, setPendingDs] = useState<string | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [fq, setFq] = useState('');
  const savedRef = useRef(false);

  const ds: Dataset | undefined = getDataset(s, d.dataset);
  const dirty = !same(d, initial);
  const { found, missing } = useMemo(() => (ds ? resolveFields(ds, d.fields) : { found: [], missing: d.fields }), [ds, d.fields]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { if (!savedRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const trimmed = d.name.trim();
  const dupName = st.reports.some((r) => r.section === s.id && r.id !== existing?.id && r.name.trim().toLowerCase() === trimmed.toLowerCase());
  const errors = {
    name: !trimmed ? 'Give the report a name.' : trimmed.length > NAME_MAX ? `Keep the name under ${NAME_MAX} characters.` : dupName ? 'Another own report in this section already uses this name.' : null,
    fields: !found.length ? 'Choose at least one column.' : null,
    dataset: !ds ? 'Choose a dataset.' : null,
  };
  const valid = !errors.name && !errors.fields && !errors.dataset;
  const canWrite = st.status === 'ok';

  const columns = useMemo(() => columnsFor(found), [found]);
  const searchText = useMemo(() => searchTextFor(found), [found]);
  const rows = useMemo(() => (ds && access.data?.platformAdmin ? scopedRows(ds, ctx, warehouse, range) : []), [ds, ctx, warehouse, range, access.data?.platformAdmin]);

  const toggle = (k: string) => setD((p) => ({ ...p, fields: p.fields.includes(k) ? p.fields.filter((x) => x !== k) : [...p.fields, k] }));
  const move = (i: number, dir: -1 | 1) => setD((p) => {
    const f = [...p.fields];
    const j = i + dir;
    if (j < 0 || j >= f.length) return p;
    [f[i], f[j]] = [f[j], f[i]];
    return { ...p, fields: f };
  });

  const requestDataset = (id: string) => {
    if (id === d.dataset) return;
    if (!d.fields.length) { setD((p) => ({ ...p, dataset: id })); return; }
    setPendingDs(id);
  };
  const pendingTarget = pendingDs ? getDataset(s, pendingDs) : undefined;
  const matching = pendingTarget ? d.fields.filter((k) => pendingTarget.fields.some((f) => f.key === k)) : [];

  const save = async () => {
    if (saving) return;
    setTouched(true);
    setSaveError(null);
    if (!valid || !ds) return;
    const input = { section: s.id, name: d.name, description: d.description, dataset: d.dataset, fields: found.map((f) => f.key), sourceDefault: existing?.sourceDefault ?? fromId };
    setSaving(true);
    const res = existing ? await updateReport(existing.id, input) : await createReport(input);
    setSaving(false);
    if (!res.ok) { setSaveError(res.error); toast({ title: 'Report not saved', description: res.error, variant: 'destructive' }); return; }
    savedRef.current = true;
    toast({ title: existing ? 'Report updated' : 'Report saved', description: `"${trimmed}" saved in your account.` });
    go(`${s.base}/own-reports/${res.report!.id}`);
  };

  const cancelTo = existing ? `${s.base}/own-reports/${existing.id}` : `${s.base}/own-reports`;
  const leave = (to: string) => (dirty ? setLeaveTo(to) : go(to));
  const avail = ds ? ds.fields.filter((f) => !fq.trim() || f.label.toLowerCase().includes(fq.trim().toLowerCase())) : [];

  return (
    <div>
      <button onClick={() => leave(cancelTo)} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground mb-2" data-testid="button-back-builder"><ArrowLeft className="h-3.5 w-3.5" />{existing ? existing.name : 'Own reports'}</button>
      <PageHeader eyebrow={`${s.eyebrow} · ${existing ? 'Edit own report' : 'New own report'}`} title={existing ? 'Edit report' : 'Build a report'}
        description={fromTitle ? `Starting from the standard "${fromTitle}" report. Saving creates your own copy; the standard report stays unchanged.` : `Choose a dataset and the ${s.label.toLowerCase()} fields to show. The preview updates as you go.`}>
        <button className={btn.ghost} onClick={() => leave(cancelTo)} data-testid="button-cancel"><X className="h-3.5 w-3.5" />Cancel</button>
        <button className={btn.primary} onClick={save} disabled={!canWrite || saving} data-testid="button-save"><Save className="h-3.5 w-3.5" />{saving ? 'Saving…' : existing ? 'Save changes' : 'Save report'}</button>
      </PageHeader>
      <StoreBanner />
      {unknownFrom && <div className="mb-3 text-[12px] text-muted-foreground" data-testid="status-unknown-source">The standard report you tried to copy was not found, so this starts blank.</div>}
      {saveError && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-[hsl(4_60%_84%)] bg-[hsl(4_75%_95%)] px-3 py-2 text-[12px] text-[hsl(4_65%_32%)]" role="alert" data-testid="status-save-error">
          <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />{saveError} Your edits are still here.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mb-4">
        <section className="rise rounded-md border bg-card p-4 space-y-4">
          <div>
            <label htmlFor="report-name" className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Report name <span className="text-destructive">*</span></label>
            <input id="report-name" value={d.name} maxLength={NAME_MAX + 20} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} onBlur={() => setTouched(true)}
              aria-invalid={touched && !!errors.name} placeholder="e.g. Chilled stock by location"
              className={cn('mt-1 h-9 w-full rounded-md border bg-background px-3 text-[14px] outline-none focus:ring-2 focus:ring-ring/30', touched && errors.name && 'border-destructive')} data-testid="input-report-name" />
            {touched && errors.name && <p className="text-[12px] text-destructive mt-1" data-testid="error-name">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="report-desc" className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Description <span className="normal-case tracking-normal">(optional)</span></label>
            <input id="report-desc" value={d.description} maxLength={240} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))}
              className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring/30" data-testid="input-report-description" />
          </div>
          {s.datasets.length > 1 ? (
            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-1">Dataset</div>
              <div role="radiogroup" aria-label="Dataset" className="grid sm:grid-cols-2 gap-2">
                {s.datasets.map((x) => (
                  <button key={x.id} role="radio" aria-checked={d.dataset === x.id} onClick={() => requestDataset(x.id)} data-testid={`button-dataset-${x.id}`}
                    className={cn('text-left rounded-md border px-3 py-2 transition-colors', d.dataset === x.id ? 'border-primary bg-primary/5' : 'hover:border-primary/40')}>
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold">{d.dataset === x.id && <Check className="h-3.5 w-3.5 text-primary" />}{x.label}</div>
                    <div className="text-[11.5px] text-muted-foreground leading-snug mt-0.5">{x.description}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : ds && (
            <div className="text-[12px] text-muted-foreground">Dataset: <span className="font-medium text-foreground">{ds.label}</span> · {ds.description}</div>
          )}
          {!ds && <p className="text-[12px] text-destructive">The saved dataset "{d.dataset}" is no longer available. Choose another.</p>}
          {ds && (
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Available fields</span>
                <span className="text-[11px] font-mono text-muted-foreground tnum">{ds.fields.length}</span>
                <label className="relative ml-auto">
                  <span className="sr-only">Filter fields</span>
                  <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input value={fq} onChange={(e) => setFq(e.target.value)} placeholder="Filter" className="h-7 w-32 rounded border bg-background pl-6 pr-2 text-[12px] outline-none" data-testid="input-filter-fields" />
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5" data-testid="list-available-fields">
                {avail.map((f) => {
                  const on = d.fields.includes(f.key);
                  return (
                    <button key={f.key} onClick={() => toggle(f.key)} aria-pressed={on} data-testid={`button-field-${f.key}`}
                      className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors', on ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:border-primary/50')}>
                      {on ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3 opacity-60" />}{f.label}
                    </button>
                  );
                })}
                {!avail.length && <span className="text-[12px] text-muted-foreground">No field matches "{fq}".</span>}
              </div>
            </div>
          )}
        </section>

        <section className="rise rounded-md border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Columns, in order</span>
            <span className="text-[11px] font-mono text-muted-foreground tnum">{found.length}</span>
            {found.length > 0 && <button onClick={() => setD((p) => ({ ...p, fields: [] }))} className="ml-auto text-[12px] text-muted-foreground hover:text-foreground" data-testid="button-clear-columns">Clear all</button>}
          </div>
          {found.length ? (
            <ol className="space-y-1" data-testid="list-selected-fields">
              {found.map((f, i) => (
                <li key={f.key} className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-[13px]" data-testid={`row-selected-${f.key}`}>
                  <span className="font-mono text-[10px] text-muted-foreground tnum w-5">{String(i + 1).padStart(2, '0')}</span>
                  <span className="flex-1 truncate">{f.label}</span>
                  <span className="hidden sm:inline font-mono text-[10px] text-muted-foreground">{f.kind}</span>
                  <button className={btn.icon} onClick={() => move(d.fields.indexOf(f.key), -1)} disabled={i === 0} aria-label={`Move ${f.label} up`} data-testid={`button-up-${f.key}`}><ArrowUp className="h-3 w-3" /></button>
                  <button className={btn.icon} onClick={() => move(d.fields.indexOf(f.key), 1)} disabled={i === found.length - 1} aria-label={`Move ${f.label} down`} data-testid={`button-down-${f.key}`}><ArrowDown className="h-3 w-3" /></button>
                  <button className={btn.icon} onClick={() => toggle(f.key)} aria-label={`Remove ${f.label}`} data-testid={`button-remove-${f.key}`}><X className="h-3 w-3" /></button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="rounded border border-dashed py-8 text-center text-[12px] text-muted-foreground grid-paper">
              <FileBarChart className="h-6 w-6 mx-auto mb-1.5 opacity-50" />Click fields on the left to add columns.
            </div>
          )}
          {missing.length > 0 && <p className="text-[12px] text-[hsl(30_75%_28%)] mt-2">Unavailable and will be dropped on save: {missing.join(', ')}</p>}
          {touched && errors.fields && <p className="text-[12px] text-destructive mt-2" data-testid="error-fields">{errors.fields}</p>}
          <div className="mt-4 pt-3 border-t text-[12px] text-muted-foreground flex items-center gap-2">
            {dirty ? <><span className="h-1.5 w-1.5 rounded-full bg-chart-2" />Unsaved changes</> : <><span className="h-1.5 w-1.5 rounded-full bg-chart-3" />No unsaved changes</>}
            <span className="ml-auto font-mono text-[11px]">your account only</span>
          </div>
        </section>
      </div>

      <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground mb-2 flex items-center gap-2">
        Live preview {ds && <span className="normal-case tracking-normal">· {scopeLabel(ds, warehouse, range)}</span>}
      </div>
      {ds && found.length ? (
        <DataReport title={trimmed || 'Untitled report'} rows={rows} columns={columns} searchText={searchText} rowKey={ds.rowKey} filename={`wareiq-${s.id}-preview-${slug(trimmed || 'untitled')}`} pageSize={10} testId="table-preview" />
      ) : (
        <div className="rounded-md border border-dashed bg-card py-10 text-center text-[13px] text-muted-foreground" data-testid="status-preview-empty">Add at least one column to preview rows.</div>
      )}
      <BrowserOnlyNote className="mt-4" />

      <AlertDialog open={!!pendingDs} onOpenChange={(o) => !o && setPendingDs(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to {pendingTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              You have {d.fields.length} column{d.fields.length === 1 ? '' : 's'} chosen from {ds?.label ?? 'the current dataset'}. {matching.length ? `${matching.length} of them also exist in ${pendingTarget?.label} and can be kept.` : `None of them exist in ${pendingTarget?.label}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel data-testid="button-cancel-switch">Stay on {ds?.label ?? 'current'}</AlertDialogCancel>
            <AlertDialogAction className="bg-secondary text-secondary-foreground hover:bg-secondary/80" data-testid="button-switch-reset" onClick={() => { setD((p) => ({ ...p, dataset: pendingDs!, fields: [] })); setPendingDs(null); }}>Switch and clear columns</AlertDialogAction>
            {matching.length > 0 && <AlertDialogAction data-testid="button-switch-keep" onClick={() => { setD((p) => ({ ...p, dataset: pendingDs!, fields: matching })); setPendingDs(null); }}>Switch, keep {matching.length}</AlertDialogAction>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!leaveTo} onOpenChange={(o) => !o && setLeaveTo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits to this report have not been saved and will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-keep-editing">Keep editing</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-discard" onClick={() => { savedRef.current = true; const to = leaveTo!; setLeaveTo(null); go(to); }}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
