import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WmsVpnSteps } from '../src/components/wms-vpn-steps';

afterEach(cleanup);
test.each([
  ['healthy', 'VPN route and database TCP port reachable. SQL login is not verified.'],
  ['unavailable', 'Unavailable — connector or warehouse route check failed.'],
  ['unknown', 'Unknown — monitoring cannot currently verify connectivity.'],
] as const)('shows %s monitoring without granting SQL readiness', (status, message) => {
  render(<WmsVpnSteps
    config={{ path: 'openvpn', configured: true, message: 'Configured',
      monitoring: { status, checkedAt: null } }}
    unavailable={false} pending={false} ready={false} result={null} onCheck={() => {}} />);
  expect(screen.getByTestId('status-vpn-monitor')).toHaveTextContent(message);
  expect(screen.getByText('No current VPN route verification for these connection fields.')).toBeVisible();
});
test('a failed status refresh overrides cached healthy monitoring', () => {
  render(<WmsVpnSteps
    config={{ path: 'openvpn', configured: true, message: 'Configured',
      monitoring: { status: 'healthy', checkedAt: '2026-10-28T12:00:00Z' } }}
    unavailable={true} pending={false} ready={false} result={null} onCheck={() => {}} />);
  expect(screen.getByTestId('status-vpn-monitor')).toHaveTextContent('Unknown');
  expect(screen.queryByText(/Last check:/)).toBeNull();
  expect(screen.getByTestId('button-test-vpn')).toBeDisabled();
});
