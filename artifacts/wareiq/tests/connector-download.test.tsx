import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConnectorDownload } from '../src/components/connector-download';

const fetchMock = vi.fn();
let anchorClick: ReturnType<typeof vi.spyOn>;
let saved: { href: string; filename: string } | undefined;

beforeEach(() => {
  saved = undefined;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:connector-test-download'),
    revokeObjectURL: vi.fn(),
  });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved = { href: this.href, filename: this.download };
  });
});
afterEach(() => {
  cleanup(); anchorClick.mockRestore(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

it('fetches the ZIP inside the preview and saves a blob without navigating Settings', async () => {
  fetchMock.mockResolvedValue({ ok: true, redirected: false,
    arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]).buffer });
  render(<ConnectorDownload />);
  fireEvent.click(screen.getByTestId('button-download-connector'));
  await waitFor(() => expect(saved).toEqual({
    href: 'blob:connector-test-download', filename: 'wareiq-openvpn-connector.zip',
  }));
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/downloads\/wareiq-openvpn-connector\.zip$/),
    { credentials: 'same-origin', redirect: 'error' });
  expect(screen.getByRole('status')).toHaveTextContent('Download requested');
  expect(screen.getByTestId('link-download-connector')).toHaveAttribute('target', '_blank');
});

it('does not save an HTML sign-in page as a ZIP and offers a new-tab fallback', async () => {
  fetchMock.mockResolvedValue({ ok: true, redirected: false,
    arrayBuffer: async () => new Uint8Array([60, 104, 116, 109, 108, 62]).buffer });
  render(<ConnectorDownload />);
  fireEvent.click(screen.getByTestId('button-download-connector'));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not start inside the preview');
  expect(saved).toBeUndefined();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByTestId('button-download-connector')).toBeEnabled();
});

it.each(['redirect', 'network', 'http-error'])('handles %s failures without navigating the frame', async (kind) => {
  if (kind === 'network') fetchMock.mockRejectedValue(new Error('blocked'));
  else fetchMock.mockResolvedValue({ ok: kind !== 'http-error', redirected: kind === 'redirect' });
  render(<ConnectorDownload />);
  fireEvent.click(screen.getByTestId('button-download-connector'));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(saved).toBeUndefined();
  expect(screen.getByTestId('link-download-connector')).toHaveAttribute('rel', 'noopener noreferrer');
});
