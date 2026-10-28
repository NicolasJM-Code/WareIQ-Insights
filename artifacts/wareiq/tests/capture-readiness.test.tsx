import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CaptureReadiness } from '@workspace/api-client-react';
import { CaptureReadinessNotice } from '../src/components/capture-readiness';

const configured: CaptureReadiness = {
  configuration: 'configured', signing: 'configured', routing: 'configured', keyMode: 'configured',
  environment: 'development', delivery: 'unknown', lastVerifiedDeliveryAt: null,
  lastDeliveryFailureAt: null, failureScope: 'environment_instance',
};
afterEach(cleanup);
it('warns about missing signing and routing without fabricating delivery health', () => {
  render(<CaptureReadinessNotice readiness={{ ...configured, configuration: 'not_configured',
    signing: 'not_configured', routing: 'not_configured', keyMode: 'not_configured',
    environment: null, delivery: 'not_configured' }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('External role capture is not configured');
  expect(screen.getByTestId('capture-readiness')).toHaveTextContent('Signing configuration: missing or invalid');
  expect(screen.getByTestId('capture-readiness')).toHaveTextContent('Routing configuration: missing or invalid');
});
it('keeps configured capture unknown until delivery evidence exists', () => {
  render(<CaptureReadinessNotice readiness={configured} />);
  expect(screen.getByText(/Delivery health unknown/)).toHaveTextContent('absence of recent role events does not mean the subscription failed');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('labels even old signed evidence as historical rather than current subscription health', () => {
  render(<CaptureReadinessNotice readiness={{ ...configured, delivery: 'verified_delivery',
    lastVerifiedDeliveryAt: '2020-01-01T00:00:00.000Z' }} />);
  expect(screen.getByText(/historical delivery evidence/)).toBeInTheDocument();
  expect(screen.getByText(/server receipt time/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('shows authenticated storage failures and their durable scope', () => {
  render(<CaptureReadinessNotice readiness={{ ...configured, delivery: 'delivery_problem',
    lastDeliveryFailureAt: '2026-10-27T12:00:00.000Z' }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be saved');
  expect(screen.getByText(/retained across restarts/)).toBeInTheDocument();
  expect(screen.getByText(/Last verified delivery storage failure/)).toBeInTheDocument();
});

it.each(['delivery_unknown', 'diagnostics_unavailable'] as const)('warns without inventing provider health for %s', (delivery) => {
  render(<CaptureReadinessNotice readiness={{ ...configured, delivery,
    lastVerifiedDeliveryAt: '2020-01-01T00:00:00.000Z' }} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/unknown/);
  expect(screen.getByText(/Last persisted signed role observation/)).toBeInTheDocument();
});
