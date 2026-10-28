import { useState } from 'react';
import { useRunAccessReport } from '@workspace/api-client-react';
import { useSelectedAccessSite } from '@/lib/use-access';

export function ReportRunControl({ reportId }: { reportId: string }) {
  const { sites, selectedSite, setSiteId } = useSelectedAccessSite();
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState<{ columns: string[]; rows: Record<string, string | number | boolean | null>[] } | null>(null);
  const mutation = useRunAccessReport();
  return <section className="rounded-md border bg-card p-4 space-y-3">
    <h2 className="font-semibold text-sm">Run report</h2>
    {!sites.length ? <p className="text-sm text-muted-foreground">No imported sites are assigned. Connect the WMS and assign sites before running reports.</p> : <>
      <label className="block text-sm">Site<select className="ml-3 rounded border bg-background p-2" value={selectedSite?.id ?? ''} onChange={(e) => setSiteId(e.target.value)} data-testid="select-report-site">
        {sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
      </select></label>
      <button className="rounded bg-primary text-primary-foreground px-4 py-2 text-sm disabled:opacity-50" data-testid="button-run-report" disabled={mutation.isPending || !selectedSite} onClick={async () => {
        setMessage('');
        setOutput(null);
        try {
          const result = await mutation.mutateAsync({ id: reportId, data: { siteId: selectedSite?.id ?? '' } });
          setMessage(result.message);
          if (result.status === 'completed') setOutput({ columns: result.columns, rows: result.rows });
        }
        catch (error) {
          const text = (error as { data?: { error?: unknown } }).data?.error;
          setMessage(typeof text === 'string' ? text : 'Report execution could not be authorised. Refresh your access and try again.');
        }
      }}>{mutation.isPending ? 'Checking access…' : 'Run report'}</button>
    </>}
    {message && <p role="status" className="text-sm" data-testid="status-run-report">{message}</p>}
    {output && <div className="max-h-96 overflow-auto rounded border" data-testid="table-live-report">
      <table className="min-w-full text-left text-xs">
        <thead className="sticky top-0 bg-muted"><tr>{output.columns.map((column) =>
          <th className="whitespace-nowrap px-3 py-2 font-semibold" key={column}>{column}</th>)}</tr></thead>
        <tbody className="divide-y">{output.rows.map((row, index) =>
          <tr key={index}>{output.columns.map((column) =>
            <td className="max-w-64 px-3 py-2 align-top" key={column}>{row[column] === null ? '—' : String(row[column])}</td>)}</tr>)}
        </tbody>
      </table>
    </div>}
  </section>;
}
