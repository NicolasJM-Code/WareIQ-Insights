import { useRef, useState } from 'react';
import { useUser } from '@clerk/react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { btn } from '@/components/reports-ui';
import { getDataset, type Section } from '@/lib/report-catalog';
import {
  clearCorruptLegacyReports,
  isLegacyReportSourceUnchanged,
  readLegacyReportSnapshot,
  type LegacyPreview,
  type LegacyReportSnapshot,
} from '@/lib/legacy-report-import';
import { importLegacyReports, NAME_MAX, type OwnReport } from '@/lib/own-reports-store';
import { safeAnalyticsSection, trackEvent } from '@/lib/analytics';
import { useAccess } from '@/lib/use-access';

export function LegacyReportImport({ section, reports, ready }: { section: Section; reports: OwnReport[]; ready: boolean }) {
  const { user } = useUser();
  const access = useAccess();
  const session = access.data;
  if (!user || !session?.clientId || !session.canCreateOwnReports ||
      !section.defaults.some((r) => session.reportIds.includes(r.id))) return null;
  // A change of account/client discards selections and ownership confirmation.
  return <ImportForAccount key={`${user.id}:${session.clientId}`} section={section} reports={reports} ready={ready}
    ownerId={user.id} accountLabel={user.primaryEmailAddress?.emailAddress ?? 'your signed-in account'}
    clientId={session.clientId} clientName={session.clientName ?? session.clientId} reportIds={session.reportIds} />;
}

function ImportForAccount({ section, reports, ready, ownerId, accountLabel, clientId, clientName, reportIds }: {
  section: Section; reports: OwnReport[]; ready: boolean; ownerId: string; accountLabel: string;
  clientId: string; clientName: string; reportIds: string[];
}) {
  const [preview, setPreview] = useState<LegacyPreview | null>(null);
  const sourceSnapshot = useRef<LegacyReportSnapshot | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState('');
  const inFlight = useRef(false);
  const cancellationTracked = useRef(false);
  function refreshPreview() {
    const snapshot = readLegacyReportSnapshot();
    sourceSnapshot.current = snapshot;
    setPreview(snapshot.preview);
    return snapshot.preview;
  }
  const candidates = preview?.candidates.filter((r) => r.input.section === section.id) ?? [];
  const picked = candidates.filter((r) => selected.includes(r.index));
  const nameFor = (r: typeof candidates[number]) => (names[r.index] ?? r.input.name).trim();
  function issue(r: typeof candidates[number]) {
    const ds = getDataset(section, r.input.dataset);
    if (!ds || r.input.fields.some((field) => !ds.fields.some((f) => f.key === field)))
      return 'Dataset or columns are no longer available. This definition cannot be imported.';
    if (r.input.sourceDefault && !reportIds.includes(r.input.sourceDefault))
      return 'Your role does not permit the source report.';
    const name = nameFor(r);
    if (!name || name.length > NAME_MAX) return `Use a name of 1–${NAME_MAX} characters.`;
    if (reports.some((saved) => saved.section === section.id && saved.name.trim().toLowerCase() === name.toLowerCase()) ||
        picked.some((other) => other.index !== r.index && nameFor(other).toLowerCase() === name.toLowerCase()))
      return 'This name is already used in this section. Rename it or leave it unselected.';
    return undefined;
  }
  function cancelImport() {
    if (!done && preview && !cancellationTracked.current) {
      cancellationTracked.current = true;
      const safeSection = safeAnalyticsSection(section.id);
      trackEvent('legacy_report_import_cancel', {
        ...(safeSection ? { section: safeSection } : {}),
        selected_count: picked.length,
      });
    }
    setPreview(null);
  }
  const canSubmit = ready && !busy && !done && confirmed && picked.length > 0 && picked.length <= 50 && picked.every((r) => !issue(r));
  return <>
    <button className={btn.ghost} disabled={!ready} data-testid="button-preview-legacy" onClick={() => {
      setSelected([]); setNames({}); setConfirmed(false); setDone(false); setError('');
      setConfirmCleanup(false); setCleanupNotice('');
      cancellationTracked.current = false;
      const nextPreview = refreshPreview();
      const safeSection = safeAnalyticsSection(section.id);
      trackEvent('legacy_report_import_preview', {
        ...(safeSection ? { section: safeSection } : {}),
        candidate_count: nextPreview.candidates.filter((r) => r.input.section === section.id).length,
        invalid_count: nextPreview.invalid,
        result: nextPreview.error ? 'failed' : nextPreview.candidates.some((r) => r.input.section === section.id) ? 'available' : 'empty',
      });
      if (nextPreview.error) {
        const reason = nextPreview.error === 'Browser storage is blocked or unavailable. Originals are unchanged.' ? 'storage_unavailable'
          : nextPreview.error === 'Browser reports are too large to preview safely. Originals are unchanged.' ? 'too_large'
            : nextPreview.error === 'Unsupported browser report format. Originals are unchanged.' ? 'unsupported_format'
              : nextPreview.error === 'Browser reports could not be read. Originals are unchanged.' ? 'unreadable_data'
                : 'preview_failed';
        trackEvent('legacy_report_import_failure', {
          ...(safeSection ? { section: safeSection } : {}),
          stage: 'preview',
          reason,
        });
      }
    }}>Import browser reports</button>
    <Dialog open={preview !== null} onOpenChange={(open) => { if (!open && !inFlight.current) cancelImport(); }}>
      <DialogContent className="max-w-2xl" data-testid="dialog-legacy-import">
        <DialogHeader>
          <DialogTitle>Import browser reports · {section.label}</DialogTitle>
          <DialogDescription>
            These browser definitions have no verified owner and may belong to someone else who used this browser.
            Select only reports you own. Nothing is selected or imported automatically.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm break-words">Destination: <strong>{accountLabel}</strong> · <strong>{clientName}</strong></p>
        {done ? <p role="status" data-testid="status-import-success">{picked.length} report{picked.length === 1 ? '' : 's'} imported into your account. Browser originals are unchanged.</p> : <>
          {preview?.error && <p role="alert" className="text-sm text-destructive">{preview.error}</p>}
          {cleanupNotice && <p role="status" className="text-sm">{cleanupNotice}</p>}
          {preview?.corruptRaw !== undefined && <>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmCleanup} disabled={busy}
                onChange={(e) => setConfirmCleanup(e.target.checked)} data-testid="checkbox-confirm-corrupt-cleanup" />
              I understand deleting these unreadable browser reports cannot be undone. Account reports will not be deleted.
            </label>
            <button type="button" className={btn.ghost} disabled={busy || !confirmCleanup}
              data-testid="button-clear-corrupt-reports" onClick={() => {
                const result = clearCorruptLegacyReports(preview.corruptRaw!, confirmCleanup);
                if (result.ok) {
                  refreshPreview(); setConfirmCleanup(false); setError('');
                  setCleanupNotice('Unreadable browser reports were deleted from this browser.');
                } else {
                  setError(result.error ?? 'Browser reports were not deleted.');
                  setConfirmCleanup(false); refreshPreview();
                }
              }}>Delete unreadable browser reports</button>
          </>}
          {!!preview?.invalid && <p className="text-sm">{preview.invalid} malformed definition(s) cannot be imported and remain unchanged.</p>}
          {!!preview && preview.candidates.length > candidates.length &&
            <p className="text-sm text-muted-foreground">Only this section is shown. Review other sections from their Own reports pages.</p>}
          {!preview?.error && !candidates.length && <p role="status">No readable browser reports in this section.</p>}
          <div className="space-y-3">
            {candidates.map((r) => {
              const ds = getDataset(section, r.input.dataset);
              const problem = issue(r);
              const unavailable = !ds || r.input.fields.some((key) => !ds.fields.some((f) => f.key === key)) ||
                !!r.input.sourceDefault && !reportIds.includes(r.input.sourceDefault);
              return <div key={r.index} className="rounded-md border p-3 space-y-2" data-testid={`legacy-report-${r.index}`}>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={selected.includes(r.index)} disabled={busy || unavailable}
                    onChange={(e) => { setConfirmed(false); setSelected((prev) => e.target.checked ? [...prev, r.index] : prev.filter((i) => i !== r.index)); }}
                    data-testid={`checkbox-legacy-${r.index}`} />
                  {r.input.name}
                </label>
                <p className="text-xs text-muted-foreground">Dataset: {ds?.label ?? r.input.dataset} · Columns, in order: {r.input.fields.map((key) => ds?.fields.find((f) => f.key === key)?.label ?? key).join(', ')}</p>
                {r.input.description && <p className="text-sm">{r.input.description}</p>}
                {r.input.sourceDefault && <p className="text-xs text-muted-foreground">Source report: {section.defaults.find((d) => d.id === r.input.sourceDefault)?.title ?? r.input.sourceDefault}</p>}
                <label className="block text-xs">Import as
                  <input value={names[r.index] ?? r.input.name} maxLength={NAME_MAX} disabled={busy || unavailable}
                    onChange={(e) => { setConfirmed(false); setNames((prev) => ({ ...prev, [r.index]: e.target.value })); }}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                    data-testid={`input-import-name-${r.index}`} />
                </label>
                {problem && <p className="text-xs text-destructive" data-testid={`legacy-issue-${r.index}`}>{problem}</p>}
              </div>;
            })}
          </div>
          {candidates.length > 0 && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy || !picked.length}
              onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" data-testid="checkbox-confirm-legacy-ownership" />
            I confirm that the selected definitions belong to me and should be copied into this account and client.
          </label>}
          <p className="text-xs text-muted-foreground">Up to 50 reports at a time. Existing account reports are never overwritten. Browser originals are never removed. The server rechecks permissions before saving; if any selection is rejected, none are imported.</p>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-legacy-import">{error}</p>}
        </>}
        <div className="flex justify-end gap-2">
          <button className={btn.ghost} disabled={busy} onClick={cancelImport} data-testid="button-cancel-legacy">{done ? 'Close' : 'Cancel'}</button>
          {!done && <button className={btn.primary} disabled={!canSubmit} data-testid="button-confirm-legacy-import" onClick={async () => {
            if (!canSubmit || inFlight.current) return;
            const safeSection = safeAnalyticsSection(section.id);
            trackEvent('legacy_report_import_confirmation', {
              ...(safeSection ? { section: safeSection } : {}),
              selected_count: picked.length,
            });
            const snapshot = sourceSnapshot.current;
            if (!snapshot || !isLegacyReportSourceUnchanged(snapshot)) {
              const freshSnapshot = readLegacyReportSnapshot();
              sourceSnapshot.current = freshSnapshot;
              setPreview(freshSnapshot.preview);
              setSelected([]);
              setNames({});
              setConfirmed(false);
              setDone(false);
              setError('Browser reports changed or could not be rechecked. Review the refreshed preview and confirm ownership again before importing.');
              return;
            }
            inFlight.current = true; setBusy(true); setError('');
            try {
              const result = await importLegacyReports({ expectedOwnerId: ownerId, expectedClientId: clientId, confirmedOwnership: true,
                reports: picked.map((r) => ({ ...r.input, name: nameFor(r) })) });
              if (result.ok) setDone(true);
              else { setError(result.error); setConfirmed(false); }
            } finally { inFlight.current = false; setBusy(false); }
          }}>{busy ? 'Importing…' : `Import ${picked.length} selected`}</button>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
