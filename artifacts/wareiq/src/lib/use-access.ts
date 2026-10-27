import { useAuth } from '@clerk/react';
import { useGetAccessSession, getGetAccessSessionQueryKey } from '@workspace/api-client-react';
import { useReport } from '@/lib/report-context';

export function useAccess() {
  const { userId, sessionId, isLoaded } = useAuth();
  return useGetAccessSession({ query: {
    queryKey: [...getGetAccessSessionQueryKey(), userId ?? 'signed-out', sessionId],
    enabled: isLoaded, staleTime: 0, refetchInterval: 15000, retry: false,
    refetchOnWindowFocus: 'always',
  }, request: { credentials: 'same-origin', cache: 'no-store' } });
}

/** Resolve the selected warehouse only from the current authorized session. */
export function useSelectedAccessSite() {
  const access = useAccess();
  const { siteId, setSiteId } = useReport();
  const sites = access.data?.sites ?? [];
  const selectedSite = sites.find((site) => site.id === siteId) ?? sites[0] ?? null;
  return { access, sites, selectedSite, setSiteId };
}
