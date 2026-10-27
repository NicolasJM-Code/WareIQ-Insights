import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { AppShell } from '@/components/shell';
import { ReportProvider } from '@/lib/report-context';
import Dashboard from '@/pages/dashboard';
import Inbound from '@/pages/inbound';
import Putaway from '@/pages/putaway';
import Inventory from '@/pages/inventory';
import Picking from '@/pages/picking';
import Outbound from '@/pages/outbound';
import Dispatch from '@/pages/dispatch';
import Traceability from '@/pages/traceability';
import StockCounts from '@/pages/stock-counts';
import Labour from '@/pages/labour';
import Exceptions from '@/pages/exceptions';
import Settings from '@/pages/settings';

const queryClient = new QueryClient();

function Router() {
  return (
    <AppShell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/inbound" component={Inbound} />
          <Route path="/putaway" component={Putaway} />
          <Route path="/inventory" component={Inventory} />
          <Route path="/picking" component={Picking} />
          <Route path="/outbound" component={Outbound} />
          <Route path="/dispatch" component={Dispatch} />
          <Route path="/traceability" component={Traceability} />
          <Route path="/stock-counts" component={StockCounts} />
          <Route path="/labour" component={Labour} />
          <Route path="/exceptions" component={Exceptions} />
          <Route path="/settings" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </AppShell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ReportProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </ReportProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
