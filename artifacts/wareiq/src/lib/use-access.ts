import { useUser } from '@clerk/react';
import { useGetAccessSession, getGetAccessSessionQueryKey } from '@workspace/api-client-react';

export function useAccess() {
  const { user, isLoaded } = useUser();
  return useGetAccessSession({ query: {
    queryKey: [...getGetAccessSessionQueryKey(), user?.id ?? 'signed-out'],
    enabled: isLoaded, staleTime: 0, refetchInterval: 15000, retry: false,
  } });
}
