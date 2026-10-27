import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fixtures = vi.hoisted(() => ({
  retry: vi.fn(),
  toast: vi.fn(),
  adminData: {
    clients: [],
    sites: [],
    roles: [],
    users: [],
    reports: [],
    notificationSummary: {
      status: "available",
      queued: 0,
      queuedOverThreshold: 0,
      oldestQueuedAgeSeconds: null as number | null,
      queueWarningAfterSeconds: 300,
      retrying: 0,
      accepted: 0,
      failed: 1,
    },
    failedNotifications: [{
      id: "3ed2c922-b996-44e4-8d9f-929d522026b2",
      recipient: "account@example.test",
      roleName: "Supervisor",
      kind: "reporting",
      createdAt: new Date("2026-10-27T12:00:00Z"),
      attempts: 2,
    }],
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetAccessAdminQueryKey: () => ["admin"],
  getGetAccessSessionQueryKey: () => ["session"],
  useGetAccessSession: () => ({
    data: { status: "active", platformAdmin: true },
    isLoading: false,
    isError: false,
  }),
  useGetAccessAdmin: () => ({
    data: fixtures.adminData,
    isLoading: false,
    isError: false,
  }),
  useSaveAccessClient: () => ({ mutateAsync: vi.fn() }),
  useRequestAccessClientLogoUpload: () => ({ mutateAsync: vi.fn() }),
  useSaveAccessClientLogo: () => ({ mutateAsync: vi.fn() }),
  useSaveAccessRole: () => ({ mutateAsync: vi.fn() }),
  useSaveAccessUser: () => ({ mutateAsync: vi.fn() }),
  useSaveAccessWarehouse: () => ({ mutateAsync: vi.fn() }),
  useDeleteAccessEntry: () => ({ mutateAsync: vi.fn() }),
  useRetryAccessNotification: () => ({ mutateAsync: fixtures.retry, isPending: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: fixtures.toast }),
}));

import UserAccess from "../src/pages/user-access";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin failed access email retries", () => {
  it("shows a retry action for confirmed failures and queues the original notice", async () => {
    fixtures.retry.mockResolvedValue({ status: "queued" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <UserAccess />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Provider-confirmed email failures")).toBeInTheDocument();
    expect(screen.getByText("account@example.test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry email" }));

    await waitFor(() => expect(fixtures.retry).toHaveBeenCalledWith({
      notificationId: "3ed2c922-b996-44e4-8d9f-929d522026b2",
    }));
    await waitFor(() => expect(fixtures.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Email retry queued",
    })));
    queryClient.clear();
  });

  it("warns about old queued notices without disabling access changes", () => {
    fixtures.adminData = {
      clients: [],
      sites: [],
      roles: [],
      users: [],
      reports: [],
      notificationSummary: {
        status: "available",
        queued: 3,
        queuedOverThreshold: 2,
        oldestQueuedAgeSeconds: 420,
        queueWarningAfterSeconds: 300,
        retrying: 0,
        accepted: 0,
        failed: 0,
      },
      failedNotifications: [],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <UserAccess />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("text-oldest-queued-age")).toHaveTextContent("Oldest queued notice: 7 minutes.");
    expect(screen.getByTestId("warning-stale-queued-notifications")).toHaveTextContent(
      "2 notices have been queued for at least 5 minutes",
    );
    expect(screen.getByTestId("button-new-client")).toBeEnabled();
    expect(screen.queryByText("account@example.test")).not.toBeInTheDocument();
    queryClient.clear();
  });
});
