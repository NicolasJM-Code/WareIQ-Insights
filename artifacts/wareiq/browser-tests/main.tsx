// Served only by the opt-in runner, never imported by the WareIQ entry point.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, SignInPage } from '../src/components/auth-provider';
import { useLocation } from 'wouter';
import { AccessGate } from '../src/components/access-gate';
import { AdministratorAccess, useAccess } from '../src/lib/access';

function PermissionIndicator() {
  const { canAdminister, canReport } = useAccess();
  return <output data-testid="permissions" data-can-administer={canAdminister} data-can-report={canReport}>
    {canAdminister && canReport ? 'allowed' : 'locked'}
  </output>;
}

function HarnessScreen() {
  const [location] = useLocation();
  // Match production routing: auth screens are public and must never receive
  // report children (AccessGate deliberately bypasses auth routes).
  return location.startsWith('/sign-in') ? <SignInPage /> : <AccessGate>
    <span data-testid="report-gate">Harmless report gate marker</span>
    <AdministratorAccess><span data-testid="admin-gate">Harmless admin gate marker</span></AdministratorAccess>
  </AccessGate>;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <AuthProvider>
      <PermissionIndicator />
      <HarnessScreen />
    </AuthProvider>
  </QueryClientProvider>,
);
