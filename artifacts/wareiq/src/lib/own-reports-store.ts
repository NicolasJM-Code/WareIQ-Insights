// Definitions are scoped to the signed-in account and client on the server.
// Legacy browser-only definitions are left untouched and never auto-imported.
import { useEffect } from 'react';
import { useUser } from '@clerk/react';
import { useListAccessOwnReports, getListAccessOwnReportsQueryKey, saveAccessOwnReport,
  deleteAccessOwnReport, type AccessOwnReport } from '@workspace/api-client-react';
import type { SectionId } from './report-catalog';
import { useAccess } from './use-access';

export const OWN_REPORTS_KEY = 'wareiq.own-reports';
export const NAME_MAX = 80;
export type OwnReport = Omit<AccessOwnReport, 'section'> & { section: SectionId };
export type OwnReportInput = Pick<OwnReport, 'section' | 'name' | 'description' | 'dataset' | 'fields' | 'sourceDefault'>;
export type SaveResult = { ok: true; report?: OwnReport } | { ok: false; error: string };
const changed = () => window.dispatchEvent(new Event('wareiq-own-reports-changed'));
function errorMessage(error: unknown) {
  const body = (error as { data?: { error?: unknown } })?.data;
  return typeof body?.error === 'string' ? body.error : 'The report could not be saved. Check your permissions and try again.';
}
export async function createReport(input: OwnReportInput): Promise<SaveResult> {
  try {
    const report = await saveAccessOwnReport(input);
    changed();
    return { ok: true, report: report as OwnReport };
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export async function updateReport(id: string, input: OwnReportInput): Promise<SaveResult> {
  try {
    const report = await saveAccessOwnReport({ ...input, id });
    changed();
    return { ok: true, report: report as OwnReport };
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export async function duplicateReport(report: OwnReport): Promise<SaveResult> {
  return createReport({ section: report.section, name: `${report.name.slice(0, 68)} (copy)`,
    description: report.description, dataset: report.dataset, fields: report.fields, sourceDefault: report.sourceDefault });
}
export async function deleteReport(id: string): Promise<SaveResult> {
  try { await deleteAccessOwnReport(id); changed(); return { ok: true }; }
  catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export function useOwnReportsState() {
  const { user } = useUser();
  const access = useAccess();
  const enabled = !!user && !!access.data?.canCreateOwnReports;
  const query = useListAccessOwnReports({ query: {
    queryKey: [...getListAccessOwnReportsQueryKey(), user?.id, access.data?.clientId],
    enabled, staleTime: 0, refetchInterval: 15000, retry: false,
  } });
  const refetch = query.refetch;
  useEffect(() => {
    const listener = () => { if (enabled) void refetch(); };
    window.addEventListener('wareiq-own-reports-changed', listener);
    return () => window.removeEventListener('wareiq-own-reports-changed', listener);
  }, [refetch, enabled]);
  return {
    status: query.isError ? 'unavailable' as const : 'ok' as const,
    reports: (enabled ? query.data ?? [] : []) as OwnReport[],
    invalid: [] as unknown[], loading: enabled && query.isLoading,
    detail: query.isError ? 'Own reports could not be loaded from your account. Retry or contact your administrator.' : undefined,
  };
}
