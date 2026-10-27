import { useState } from 'react';
import { useRunAccessReport } from '@workspace/api-client-react';
import { useAccess } from '@/lib/use-access';
import { useReport } from '@/lib/report-context';

export function ReportRunControl({ reportId }: { reportId: string }) {
  const access = useAccess();
  const { siteId, setSiteId } = useReport();
  const [message, setMessage] = useState('');
  const mutation = useRunAccessReport();
  const sites = access.data?.sites ?? [];
  const selected = sites.some((site) => site.id === siteId) ? siteId : sites[0]?.id ?? '';
  return <section className="rounded-md border bg-card p-4 space-y-3">
    <h2 className="font-semibold text-sm">Run report</h2>
    {!sites.length ? <p className="text-sm text-muted-foreground">No imported sites are assigned. Connect the WMS and assign sites before running reports.</p> : <>
      <label className="block text-sm">Site<select className="ml-3 rounded border bg-background p-2" value={selected} onChange={(e) => setSiteId(e.target.value)}>
        {sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
      </select></label>
      <button className="rounded bg-primary text-primary-foreground px-4 py-2 text-sm disabled:opacity-50" disabled={mutation.isPending} onClick={async () => {
        setMessage('');
        try { const result = await mutation.mutateAsync({ id: reportId, data: { siteId: selected } }); setMessage(result.message); }
        catch (error) {
          const text = (error as { data?: { error?: unknown } }).data?.error;
          setMessage(typeof text === 'string' ? text : 'Report execution could not be authorised. Refresh your access and try again.');
        }
      }}>{mutation.isPending ? 'Checking access…' : 'Run report'}</button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
