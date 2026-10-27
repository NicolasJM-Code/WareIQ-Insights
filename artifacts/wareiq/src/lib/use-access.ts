import { useAuth } from '@clerk/react';
import { useGetAccessSession, getGetAccessSessionQueryKey } from '@workspace/api-client-react';

export function useAccess() {
  const { userId, sessionId, isLoaded } = useAuth();
  return useGetAccessSession({ query: {
    queryKey: [...getGetAccessSessionQueryKey(), userId ?? 'signed-out', sessionId],
    enabled: isLoaded, staleTime: 0, refetchInterval: 15000, retry: false,
    refetchOnWindowFocus: 'always',
  }, request: { credentials: 'same-origin', cache: 'no-store' } });
}
