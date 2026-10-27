import { useEffect, useRef, type ReactNode } from 'react';
import { ClerkProvider, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
}

export function ClearUserCache() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const id = user?.id ?? null;
    if (previous.current !== undefined && previous.current !== id) queryClient.clear();
    previous.current = id;
  }), [addListener, queryClient]);
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  if (!clerkPubKey) return <div role="alert">Authentication is not configured. Configure the Clerk publishable key before testing connections.</div>;
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    appearance={{
      variables: { colorPrimary: '#205967', fontFamily: 'Inter, sans-serif', borderRadius: '0.375rem' },
      options: { logoImageUrl: `${window.location.origin}${basePath}/logo.svg`, logoLinkUrl: basePath || '/' },
    }}
    localization={{ signIn: { start: { title: 'Sign in to WareIQ', subtitle: 'Administrator access is required to test WMS connections' } } }}
  >
    <ClearUserCache />
    {children}
  </ClerkProvider>;
}
