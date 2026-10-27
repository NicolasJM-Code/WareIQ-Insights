import { type ReactNode } from 'react';
import { Show } from '@clerk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Redirect, useLocation, Router as WouterRouter } from 'wouter';
import { AuthProvider, Landing, SignInPage, SignUpPage } from '@/components/auth-provider';
import { ReportingAccess, AdministratorAccess } from '@/lib/access';
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
import { SECTIONS } from '@/lib/report-catalog';
import { ReportsIndex, DefaultReportView } from '@/pages/section-reports';
import { OwnReportsIndex, OwnReportView, OwnReportBuilder } from '@/pages/own-reports';

const queryClient = new QueryClient();

function Router() {
  return (
    <AppShell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/dashboard" component={Dashboard} />
          {SECTIONS.flatMap((s) => [
            <Route key={`${s.id}-r`} path={`${s.base}/reports`}><ReportsIndex sectionId={s.id} /></Route>,
            <Route key={`${s.id}-rv`} path={`${s.base}/reports/:reportId`}><DefaultReportView sectionId={s.id} /></Route>,
            <Route key={`${s.id}-o`} path={`${s.base}/own-reports`}><OwnReportsIndex sectionId={s.id} /></Route>,
            <Route key={`${s.id}-on`} path={`${s.base}/own-reports/new`}><OwnReportBuilder key="new" sectionId={s.id} /></Route>,
            <Route key={`${s.id}-oe`} path={`${s.base}/own-reports/:id/edit`}><OwnReportBuilder key="edit" sectionId={s.id} /></Route>,
            <Route key={`${s.id}-ov`} path={`${s.base}/own-reports/:id`}><OwnReportView sectionId={s.id} /></Route>,
          ])}
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
          <Route path="/settings"><AdministratorAccess><Settings /></AdministratorAccess></Route>
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthProvider>
            <Switch>
              <Route path="/"><Show when="signed-in"><Redirect to="/dashboard" /></Show><Show when="signed-out"><Landing /></Show></Route>
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route><ReportingAccess><ReportProvider><Router /></ReportProvider></ReportingAccess></Route>
            </Switch>
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
