import { type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Link, useLocation } from 'wouter';
import { AccessMessage } from '@/lib/access';

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    signInFallbackRedirectUrl={`${basePath}/dashboard`}
    signUpFallbackRedirectUrl={`${basePath}/dashboard`}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    appearance={{
      theme: shadcn,
      cssLayerName: 'clerk',
      options: { logoImageUrl: `${window.location.origin}${basePath}/logo.svg`, logoLinkUrl: basePath || '/', logoPlacement: 'inside' },
      variables: {
        colorPrimary: '#496a32', colorForeground: '#222820', colorMutedForeground: '#5e665a',
        colorBackground: '#ffffff', colorInput: '#ffffff', colorInputForeground: '#222820',
        colorDanger: '#b42318', colorNeutral: '#495044', fontFamily: '"IBM Plex Sans", sans-serif', borderRadius: '6px',
      },
      elements: { cardBox: 'bg-white rounded-lg w-[440px] max-w-full', card: '!shadow-none !border-0 !bg-transparent', footer: '!bg-transparent' },
    }}
    localization={{
      signIn: { start: { title: 'Welcome to WareIQ', subtitle: 'Sign in for warehouse reporting' } },
      signUp: { start: { title: 'Join WareIQ', subtitle: 'Reporting access requires approval from the application owner' } },
    }}
  >{children}</ClerkProvider>;
}

export function SignInPage() {
  return <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}
export function SignUpPage() {
  return <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}
export function Landing() {
  return <AccessMessage title="Warehouse reporting, from receiving to dispatch">
    <p>WareIQ brings warehouse performance, stock flow and product traceability into one reporting workspace.</p>
    <p>Reporting is available to approved supervisors and administrators. Database configuration is restricted to administrators.</p>
    <p className="rounded border bg-muted p-3 text-xs">Current reports use labeled sample data. No live WMS reporting connection has been made.</p>
    <div className="flex gap-4 items-center"><Link href="/sign-in" className="rounded bg-primary px-4 py-2 text-primary-foreground font-medium">Sign in</Link><Link href="/sign-up" className="underline">Create an account</Link></div>
  </AccessMessage>;
}
