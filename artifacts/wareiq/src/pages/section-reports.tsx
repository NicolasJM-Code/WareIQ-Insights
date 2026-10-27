import { Link } from 'wouter';
import { Printer } from 'lucide-react';
import { PageHeader } from '@/components/report-kit';
import { getSection, type SectionId } from '@/lib/report-catalog';
import { useDocTitle } from '@/lib/report-context';
import { btn } from '@/components/reports-ui';
import { useSelectedAccessSite } from '@/lib/use-access';
import { useParams } from 'wouter';
import { ReportRunControl } from '@/components/report-run-control';

function postalAddress(parts: (string | null | undefined)[]) {
  const [line1, line2, city, region, postalCode, country] = parts;
  const locality = [city, region, postalCode].filter(Boolean).join(', ');
  return [line1, line2, locality, country].filter(Boolean);
}

export function ReportsIndex({ sectionId }: { sectionId: SectionId }) {
  const section = getSection(sectionId)!;
  const { access } = useSelectedAccessSite();
  useDocTitle(`${section.label} reports`);
  return (
    <div>
      <PageHeader
        eyebrow={`${section.eyebrow} · Reports`}
        title="Default reports"
        description="Report names only. The actual reports will be developed later."
      />
      <ol className="rise rounded-md border bg-card divide-y" data-testid="list-default-reports">
        {section.defaults.filter((report) => access.data?.reportIds.includes(report.id)).map((report, index) => (
          <li key={report.id} className="flex items-center gap-4 px-4 py-3.5" data-testid={`card-report-${report.id}`}>
            <span className="font-mono text-[11px] text-muted-foreground tnum">{String(index + 1).padStart(2, '0')}</span>
            <Link href={`${section.base}/reports/${report.id}`} className="text-[14px] font-medium hover:underline">{report.title}</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Old bookmarks must not open previously generated sample reports.
export function DefaultReportView({ sectionId }: { sectionId: SectionId }) {
  const section = getSection(sectionId)!;
  const { reportId } = useParams<{ reportId: string }>();
  const report = section.defaults.find((r) => r.id === reportId);
  const { access, selectedSite } = useSelectedAccessSite();
  const client = access.data;
  useDocTitle(report?.title ?? 'Default reports');
  const clientAddress = postalAddress([
    client?.clientAddressLine1,
    client?.clientAddressLine2,
    client?.clientCity,
    client?.clientRegion,
    client?.clientPostalCode,
    client?.clientCountry,
  ]);
  const warehouseAddress = selectedSite ? postalAddress([
    selectedSite.addressLine1,
    selectedSite.addressLine2,
    selectedSite.city,
    selectedSite.region,
    selectedSite.postalCode,
    selectedSite.country,
  ]) : [];
  return (
    <div>
      {!report ? <>
        <PageHeader eyebrow={`${section.eyebrow} · Reports`} title="Report not found"
          description="This report is not available in this section." />
        <Link href={`${section.base}/reports`} className={btn.ghost}>Back to default reports</Link>
      </> : <>
        <div className="print-hide mb-4 flex flex-wrap items-center justify-between gap-3">
          <Link href={`${section.base}/reports`} className={btn.ghost}>Back to default reports</Link>
          <button type="button" className={btn.primary} onClick={() => window.print()} data-testid="button-print-report">
            <Printer className="h-3.5 w-3.5" />Print report
          </button>
        </div>
        <article className="print-report rounded-md border bg-card p-6 md:p-8" data-testid="report-print-layout">
          <header className="flex flex-wrap items-start justify-between gap-5 border-b pb-5">
            <div className="flex min-w-0 items-center gap-4">
              {client?.clientLogoUrl && <img
                src={client.clientLogoUrl}
                alt={`${client.clientName || 'Client'} logo`}
                className="max-h-16 max-w-40 object-contain"
                loading="eager"
                referrerPolicy="no-referrer"
                data-testid="img-client-logo"
                onError={(event) => { event.currentTarget.hidden = true; }}
              />}
              <div>
                <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground">WareIQ · {section.label}</p>
                <h1 className="mt-1 font-display text-3xl font-bold leading-tight" data-testid="text-print-report-title">{report.title}</h1>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{report.description}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="text-report-generated">Printed {new Date().toLocaleString()}</p>
          </header>

          <div className="grid gap-6 border-b py-5 sm:grid-cols-2">
            <section aria-labelledby="print-client-heading" data-testid="print-client-details">
              <h2 id="print-client-heading" className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Client</h2>
              <p className="font-semibold" data-testid="text-print-client-name">{client?.clientName || 'Client details unavailable'}</p>
              <p className="text-sm" data-testid="text-print-company-number">Company no. {client?.clientCompanyNumber || 'Not provided'}</p>
              <address className="mt-1 whitespace-pre-line text-sm not-italic" data-testid="text-print-client-address">
                {clientAddress.length ? clientAddress.join('\n') : 'Postal address not provided'}
              </address>
            </section>
            <section aria-labelledby="print-warehouse-heading" data-testid="print-warehouse-details">
              <h2 id="print-warehouse-heading" className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Warehouse</h2>
              <p className="font-semibold" data-testid="text-print-warehouse-name">{selectedSite?.name || 'No assigned warehouse selected'}</p>
              <address className="whitespace-pre-line text-sm not-italic" data-testid="text-print-warehouse-address">
                {warehouseAddress.length ? warehouseAddress.join('\n') : 'Postal address not provided'}
              </address>
              <p className="mt-1 text-sm" data-testid="text-print-warehouse-phone">Contact phone: {selectedSite?.contactPhone || 'Not provided'}</p>
            </section>
          </div>

          <section className="py-5" aria-label="Report output">
            <h2 className="font-semibold">Report output</h2>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="status-report-output">
              Live report data is not available until the WMS connection and approved report source mapping are configured.
            </p>
          </section>
        </article>
        <div className="print-hide mt-5">
          <ReportRunControl reportId={report.id} />
        </div>
      </>}
    </div>
  );
}
