import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AccessHistoryEntry } from '@workspace/api-client-react';

const state = vi.hoisted(() => ({
  userId: 'user_admin_a', sessionId: 'session_a',
  load: vi.fn(),
}));
vi.mock('@clerk/react', () => ({ useAuth: () => ({ userId: state.userId, sessionId: state.sessionId }) }));
vi.mock('@workspace/api-client-react', () => ({
  getListAccessHistoryQueryKey: (params?: unknown) => params ? ['/api/admin/access-history', params] : ['/api/admin/access-history'],
  listAccessHistory: state.load,
}));
vi.mock('../src/components/report-kit', () => ({ Pill: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
import { AccessHistory } from '../src/components/access-history';

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const tree = () => <QueryClientProvider client={client}><AccessHistory /></QueryClientProvider>;
  return { client, ...render(tree()), tree };
}
const entry: AccessHistoryEntry = {
  id: 'c747e2d6-7ca8-4558-8af5-3c59ff419a46',
  actorId: 'user_audit_actor', targetId: 'user_audit_target',
  createdAt: '2026-10-27T15:00:00.123Z', finishedAt: null,
  previousRole: 'unassigned', requestedRole: 'admin', resultingRole: null,
  outcome: 'unconfirmed', reason: 'provider_outcome_unknown',
};
beforeEach(() => {
  vi.resetAllMocks();
  state.userId = 'user_admin_a'; state.sessionId = 'session_a';
  state.load.mockResolvedValue({ entries: [], nextCursor: null });
});
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) { await client.cancelQueries(); client.clear(); }
});

it('shows loading followed by a real empty state, not unavailable audit-log copy', async () => {
  mount();
  expect(screen.getByRole('status')).toHaveTextContent('Loading access history');
  await screen.findByText('No platform role attempts recorded yet.');
  expect(state.load).toHaveBeenCalledWith({}, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
});
it('shows unknown provider outcomes without claiming the requested role was confirmed', async () => {
  state.load.mockResolvedValue({ entries: [entry], nextCursor: null });
  mount();
  await screen.findByText('user_audit_actor');
  expect(screen.getByText('user_audit_target')).toBeInTheDocument();
  expect(screen.getByText('Unconfirmed')).toBeInTheDocument();
  expect(screen.getByText('Not confirmed')).toBeInTheDocument();
  expect(screen.getByText(/provider did not confirm/)).toBeInTheDocument();
  expect(screen.getByRole('table')).toHaveTextContent('No platform role');
});
it('shows an error and retry, rather than a fabricated empty history', async () => {
  state.load.mockRejectedValue(new Error('offline'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('No records could be loaded');
  expect(screen.queryByText('No platform role attempts recorded yet.')).not.toBeInTheDocument();
  state.load.mockResolvedValue({ entries: [], nextCursor: null });
  fireEvent.click(screen.getByText('Retry history'));
  await screen.findByText('No platform role attempts recorded yet.');
});
it('shows declared command operators without presenting them as verified app administrators', async () => {
  state.load.mockResolvedValue({ entries: [{
    ...entry, actorId: 'operator:ops-alias', outcome: 'denied', reason: 'command_target_ineligible',
  }], nextCursor: null });
  mount();
  await screen.findByText('operator:ops-alias');
  expect(screen.getByText(/not a verified app administrator/)).toBeInTheDocument();
  expect(screen.getByText(/Recovery command requires one verified/)).toBeInTheDocument();
  expect(screen.getByText(/do not prove a dashboard edit/)).toBeInTheDocument();
});
it('separates signed provider observations with unknown actors from confirmed Settings attempts', async () => {
  state.load.mockResolvedValue({ entries: [{
    ...entry, actorId: 'external:clerk', previousRole: null, requestedRole: null,
    resultingRole: 'admin', outcome: 'observed', reason: 'provider_role_observed',
    providerEnvironment: 'development', providerEventId: 'msg_signedEvent',
    providerOccurredAt: '2026-10-26T12:00:00.000Z',
  }], nextCursor: null });
  mount();
  await screen.findByText('External provider · actor unknown');
  expect(screen.getByText('Provider role observed')).toBeInTheDocument();
  expect(screen.getByText(/development · msg_signedEvent/)).toBeInTheDocument();
  expect(screen.getByText(/Provider event .*received at the time above/)).toBeInTheDocument();
  expect(screen.getByText(/not proof of a role transition/)).toBeInTheDocument();
  expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeInTheDocument();
});
it('uses server cursors for older pages and resets to the newest page on refresh', async () => {
  const cursor = { beforeTime: entry.createdAt, beforeId: entry.id };
  state.load.mockImplementation(async (params) => ({
    entries: [{ ...entry, actorId: params.beforeId ? 'user_older_actor' : 'user_newest_actor' }],
    nextCursor: params.beforeId ? null : cursor,
  }));
  mount();
  await screen.findByText('user_newest_actor');
  fireEvent.click(screen.getByText('Older'));
  await screen.findByText('user_older_actor');
  expect(state.load).toHaveBeenCalledWith(cursor, expect.any(Object));
  expect(screen.getByText('Page 2')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Refresh history'));
  await screen.findByText('Page 1');
  expect(screen.queryByText('user_older_actor')).not.toBeInTheDocument();
});
it('never shows one session’s cached history while a different session loads', async () => {
  state.load.mockResolvedValueOnce({ entries: [entry], nextCursor: null });
  const view = mount();
  await screen.findByText('user_audit_actor');
  state.load.mockImplementation(() => new Promise(() => {}));
  state.userId = 'user_admin_b'; state.sessionId = 'session_b';
  view.rerender(view.tree());
  await waitFor(() => expect(screen.queryByText('user_audit_actor')).not.toBeInTheDocument());
  expect(screen.getByRole('status')).toHaveTextContent('Loading access history');
});
