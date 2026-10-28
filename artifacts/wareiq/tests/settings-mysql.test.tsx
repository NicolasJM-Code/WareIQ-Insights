import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({
  test: vi.fn(), vpn: vi.fn(),
  siteId: undefined as string | undefined,
  network: { path: 'direct' as 'direct' | 'openvpn', configured: true, message: 'Direct connection' },
}));
vi.mock('@clerk/react', () => ({
  useUser: () => ({ isSignedIn: true, user: { id: 'user_fixture_admin' } }),
  UserButton: () => null,
}));
vi.mock('@workspace/api-client-react', () => ({
  useTestWmsConnection: () => ({ mutateAsync: state.test, isPending: false }),
  useGetWmsNetworkConfig: () => ({ data: state.network, isError: false }),
  useTestWmsVpn: () => ({ mutateAsync: state.vpn, isPending: false }),
}));
vi.mock('../src/lib/report-context', () => ({
  useDocTitle: () => {},
  useReport: () => ({
    siteId: state.siteId,
    prefs: { refreshInterval: '5', queryTimeoutSec: 30, targetPickAccuracy: 99,
      targetFillRate: 99, targetDockToStockMin: 60 },
    setPrefs: vi.fn(), resetPrefs: vi.fn(),
  }),
}));
vi.mock('../src/components/access-management', () => ({ AccessManagement: () => null }));
vi.mock('../src/components/access-history', () => ({ AccessHistory: () => null }));
vi.mock('../src/lib/use-access', () => ({ useAccess: () => ({ data: { sites: [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Warehouse one' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Warehouse two' },
] } }) }));
// Exercise the form's value contract without Radix portal/browser geometry.
vi.mock('../src/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: {
    value: string; onValueChange: (value: string) => void; children: ReactNode;
  }) => <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
}));
import Settings from '../src/pages/settings';

beforeAll(() => vi.stubGlobal('ResizeObserver', class {
  observe() {} unobserve() {} disconnect() {}
}));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup(); vi.clearAllMocks();
  state.network = { path: 'direct', configured: true, message: 'Direct connection' };
  state.siteId = undefined;
});

it('defaults to PostgreSQL and switches MySQL port, schema and secret guidance', async () => {
  render(<Settings />);
  expect(screen.getByText('PostgreSQL connection definition')).toBeInTheDocument();
  expect(screen.getByTestId('input-port')).toHaveValue('5432');
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mysql' } });
  expect(screen.getByText('MySQL connection definition')).toBeInTheDocument();
  expect(screen.getByTestId('link-download-connector')).toHaveAttribute('download', 'wareiq-openvpn-connector.zip');
  expect(screen.getByTestId('link-download-connector').getAttribute('href')).toMatch(/\/downloads\/wareiq-openvpn-connector\.zip$/);
  expect(screen.getByTestId('input-port')).toHaveValue('3306');
  expect(screen.getByTestId('input-schema')).toHaveAttribute('readonly');
  expect(screen.getAllByText('WMS_MYSQL_DATABASE_URL').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByTestId('input-database'), { target: { value: 'reporting' } });
  await waitFor(() => expect(screen.getByTestId('input-schema')).toHaveValue('reporting'));
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'postgresql' } });
  expect(screen.getByTestId('input-port')).toHaveValue('5432');
  expect(screen.getByTestId('input-schema')).toHaveValue('public');
});

it('sends the MySQL engine and matching schema, and displays the real test result', async () => {
  state.test.mockResolvedValue({
    status: 'error', code: 'PASSWORD_NOT_CONFIGURED', testedAt: '2026-10-28T00:00:00Z',
    message: 'Configure the MySQL credentials on the server.',
  });
  render(<Settings />);
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mysql' } });
  for (const [id, value] of [
    ['input-host', 'wms.example.test'], ['input-database', 'reporting'], ['input-username', 'reporter'],
  ]) fireEvent.change(screen.getByTestId(id), { target: { value } });
  fireEvent.click(screen.getByTestId('button-test-connection'));
  await waitFor(() => expect(state.test).toHaveBeenCalledWith({
    data: { engine: 'mysql', host: 'wms.example.test', port: 3306, database: 'reporting',
      schema: 'reporting', username: 'reporter', sslMode: 'verify-full', queryTimeoutSec: 30 },
  }));
  expect(await screen.findByText('Connection test failed')).toBeInTheDocument();
  expect(screen.getAllByText(/Configure the MySQL credentials/).length).toBeGreaterThan(0);
});

it('preserves an explicitly chosen non-default port when switching engines', () => {
  render(<Settings />);
  fireEvent.change(screen.getByTestId('input-port'), { target: { value: '13306' } });
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mysql' } });
  expect(screen.getByTestId('input-port')).toHaveValue('13306');
});

it('requires VPN readiness before SQL and clears it when connection fields change', async () => {
  state.siteId = '11111111-1111-4111-8111-111111111111';
  state.network = { path: 'openvpn', configured: true, message: 'VPN required before SQL' };
  state.vpn.mockResolvedValue({ status: 'ready', code: 'VPN_READY', message: 'VPN verified',
    testedAt: '2026-10-28T00:00:00Z' });
  render(<Settings />);
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mysql' } });
  for (const [id, value] of [
    ['input-host', 'wms.example.test'], ['input-database', 'reporting'], ['input-username', 'reporter'],
  ]) fireEvent.change(screen.getByTestId(id), { target: { value } });
  expect(screen.getByTestId('button-test-connection')).toBeDisabled();
  fireEvent.click(screen.getByTestId('button-test-vpn'));
  await waitFor(() => expect(screen.getByTestId('button-test-connection')).toBeEnabled());
  expect(state.test).not.toHaveBeenCalled();
  expect(screen.getByTestId('status-vpn-result')).toHaveTextContent('VPN_READY');
  fireEvent.change(screen.getByTestId('input-host'), { target: { value: 'different.example.test' } });
  await waitFor(() => expect(screen.getByTestId('button-test-connection')).toBeDisabled());
  expect(screen.queryByTestId('status-vpn-result')).not.toBeInTheDocument();
});

it('keeps SQL locked when the VPN check fails', async () => {
  state.siteId = '11111111-1111-4111-8111-111111111111';
  state.network = { path: 'openvpn', configured: true, message: 'VPN required before SQL' };
  state.vpn.mockResolvedValue({ status: 'error', code: 'VPN_NOT_READY',
    message: 'The route is unavailable.', testedAt: '2026-10-28T00:00:00Z' });
  render(<Settings />);
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mysql' } });
  for (const [id, value] of [
    ['input-host', 'wms.example.test'], ['input-database', 'reporting'], ['input-username', 'reporter'],
  ]) fireEvent.change(screen.getByTestId(id), { target: { value } });
  fireEvent.click(screen.getByTestId('button-test-vpn'));
  expect(await screen.findByTestId('status-vpn-result')).toHaveTextContent('VPN_NOT_READY');
  expect(screen.getByTestId('button-test-connection')).toBeDisabled();
  expect(state.test).not.toHaveBeenCalled();
});

it('clears readiness on site change and ignores a late response from the previous site', async () => {
  state.siteId = '11111111-1111-4111-8111-111111111111';
  state.network = { path: 'openvpn', configured: true, message: 'VPN required' };
  let resolve!: (value: unknown) => void;
  state.vpn.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = render(<Settings />);
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mysql' } });
  for (const [id, value] of [['input-host', 'wms.example.test'], ['input-database', 'reporting'], ['input-username', 'reporter']])
    fireEvent.change(screen.getByTestId(id), { target: { value } });
  fireEvent.click(screen.getByTestId('button-test-vpn'));
  await waitFor(() => expect(state.vpn).toHaveBeenCalledWith({ data: expect.objectContaining({ siteId: state.siteId }) }));
  state.siteId = '33333333-3333-4333-8333-333333333333';
  view.rerender(<Settings />);
  resolve({ status: 'ready', code: 'VPN_READY', message: 'Old site ready' });
  await waitFor(() => expect(screen.getByTestId('button-test-connection')).toBeDisabled());
  expect(screen.queryByTestId('status-vpn-result')).not.toBeInTheDocument();
  state.vpn.mockResolvedValue({ status: 'ready', code: 'VPN_READY', message: 'New site ready' });
  fireEvent.click(screen.getByTestId('button-test-vpn'));
  await waitFor(() => expect(screen.getByTestId('button-test-connection')).toBeEnabled());
  state.siteId = '11111111-1111-4111-8111-111111111111';
  view.rerender(<Settings />);
  expect(screen.getByTestId('button-test-connection')).toBeDisabled();
});
