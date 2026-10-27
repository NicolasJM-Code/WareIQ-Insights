// Served only by the opt-in runner, never imported by the WareIQ entry point.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/components/auth-provider';
import { AccessGate } from '../src/components/access-gate';
import { AdministratorAccess, useAccess } from '../src/lib/access';

function PermissionIndicator() {
  const { canAdminister, canReport } = useAccess();
  return <output data-testid="permissions">{canAdminister && canReport ? 'allowed' : 'locked'}</output>;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <AuthProvider>
      <PermissionIndicator />
      <AccessGate>
        <span data-testid="report-gate">Harmless report gate marker</span>
        <AdministratorAccess><span data-testid="admin-gate">Harmless admin gate marker</span></AdministratorAccess>
      </AccessGate>
    </AuthProvider>
  </QueryClientProvider>,
);
