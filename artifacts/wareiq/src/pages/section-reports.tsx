import { Link } from 'wouter';
import { PageHeader } from '@/components/report-kit';
import { getSection, type SectionId } from '@/lib/report-catalog';
import { useDocTitle } from '@/lib/report-context';
import { btn } from '@/components/reports-ui';
import { useAccess } from '@/lib/use-access';
import { useParams } from 'wouter';
import { ReportRunControl } from '@/components/report-run-control';

export function ReportsIndex({ sectionId }: { sectionId: SectionId }) {
  const section = getSection(sectionId)!;
  const access = useAccess();
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
  useDocTitle('Default reports');
  return (
    <div>
      <PageHeader eyebrow={`${section.eyebrow} · Reports`} title={report?.title ?? 'Report not found'}
        description="Default reports are currently listed by name only. Their contents will be developed later." />
      <Link href={`${section.base}/reports`} className={btn.ghost}>Back to default reports</Link>
      {report && <ReportRunControl reportId={report.id} />}
    </div>
  );
}
