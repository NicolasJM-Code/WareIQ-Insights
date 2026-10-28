import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  user: { id: "account-a", primaryEmailAddress: { emailAddress: "a@example.test" } },
  access: {
    data: {
      clientId: "client-a",
      clientName: "Client A",
      canCreateOwnReports: true,
      ownReportSections: ["inbound"],
      reportIds: ["inbound-1"],
    },
  },
  importLegacyReports: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: state.user }),
}));
vi.mock("@/lib/use-access", () => ({
  useAccess: () => state.access,
}));
vi.mock("@/lib/own-reports-store", () => ({
  NAME_MAX: 80,
  importLegacyReports: state.importLegacyReports,
}));

import { LegacyReportImport } from "../src/components/legacy-report-import";
import { SECTIONS } from "../src/lib/report-catalog";
import { LEGACY_REPORTS_KEY } from "../src/lib/legacy-report-import";

const section = SECTIONS.find((item) => item.id === "inbound")!;
const originalReports = [
  {
    id: "legacy-a",
    section: "inbound",
    name: "Already saved",
    description: "Original A",
    dataset: "receipts",
    fields: ["supplier", "id"],
    createdAt: "2025-01-01",
    updatedAt: "2025-01-02",
  },
  {
    id: "legacy-b",
    section: "inbound",
    name: "Keep unselected",
    description: "Original B",
    dataset: "receipts",
    fields: ["supplier", "id"],
    createdAt: "2025-02-01",
    updatedAt: "2025-02-02",
  },
];
const originalStorage = JSON.stringify({ version: 1, reports: originalReports });
const existingReports = [{
  id: "saved-a",
  section: "inbound" as const,
  name: "Already saved",
  description: "",
  dataset: "receipts",
  fields: ["supplier"],
  createdAt: "2025-03-01",
  updatedAt: "2025-03-02",
}];

function mount() {
  return render(<LegacyReportImport section={section} reports={existingReports} ready />);
}

function openImportDialog() {
  fireEvent.click(screen.getByTestId("button-preview-legacy"));
  return screen.findByTestId("dialog-legacy-import");
}

beforeEach(() => {
  state.user = { id: "account-a", primaryEmailAddress: { emailAddress: "a@example.test" } };
  state.access = {
    data: {
      clientId: "client-a",
      clientName: "Client A",
      canCreateOwnReports: true,
      ownReportSections: ["inbound"],
      reportIds: ["inbound-1"],
    },
  };
  state.importLegacyReports.mockReset().mockResolvedValue({ ok: true });
  window.localStorage.setItem(LEGACY_REPORTS_KEY, originalStorage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("legacy report import consent", () => {
  it("starts with no reports selected or consented, and cancellation leaves browser data unchanged", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    mount();

    await openImportDialog();
    expect(screen.getByTestId("checkbox-legacy-0")).not.toBeChecked();
    expect(screen.getByTestId("checkbox-legacy-1")).not.toBeChecked();
    expect(screen.getByTestId("checkbox-confirm-legacy-ownership")).not.toBeChecked();
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeDisabled();

    fireEvent.click(screen.getByTestId("button-cancel-legacy"));
    await waitFor(() => expect(screen.queryByTestId("dialog-legacy-import")).not.toBeInTheDocument());

    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(originalStorage);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(state.importLegacyReports).not.toHaveBeenCalled();
  });

  it("requires ownership confirmation, forces rename conflicts to be resolved, and imports only selected definitions", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    mount();
    await openImportDialog();

    fireEvent.click(screen.getByTestId("checkbox-legacy-0"));
    expect(screen.getByTestId("legacy-issue-0")).toHaveTextContent("already used");
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeDisabled();

    fireEvent.change(screen.getByTestId("input-import-name-0"), { target: { value: "My receiving report" } });
    expect(screen.queryByTestId("legacy-issue-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeDisabled();

    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    expect(screen.getByTestId("button-confirm-legacy-import")).toHaveTextContent("Import 1 selected");
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    await waitFor(() => expect(state.importLegacyReports).toHaveBeenCalledOnce());
    expect(state.importLegacyReports).toHaveBeenCalledWith({
      expectedOwnerId: "account-a",
      expectedClientId: "client-a",
      confirmedOwnership: true,
      reports: [{
        section: "inbound",
        name: "My receiving report",
        description: "Original A",
        dataset: "receipts",
        fields: ["supplier", "id"],
      }],
    });
    expect(screen.getByTestId("status-import-success")).toHaveTextContent("Browser originals are unchanged");
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(originalStorage);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("sends every selected report in one request and reports the full imported count", async () => {
    mount();
    await openImportDialog();

    fireEvent.click(screen.getByTestId("checkbox-legacy-0"));
    fireEvent.change(screen.getByTestId("input-import-name-0"), { target: { value: "My receiving report" } });
    fireEvent.click(screen.getByTestId("checkbox-legacy-1"));
    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    expect(screen.getByTestId("button-confirm-legacy-import")).toHaveTextContent("Import 2 selected");
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    await waitFor(() => expect(state.importLegacyReports).toHaveBeenCalledOnce());
    expect(state.importLegacyReports).toHaveBeenCalledWith({
      expectedOwnerId: "account-a",
      expectedClientId: "client-a",
      confirmedOwnership: true,
      reports: [
        {
          section: "inbound",
          name: "My receiving report",
          description: "Original A",
          dataset: "receipts",
          fields: ["supplier", "id"],
        },
        {
          section: "inbound",
          name: "Keep unselected",
          description: "Original B",
          dataset: "receipts",
          fields: ["supplier", "id"],
        },
      ],
    });
    expect(await screen.findByTestId("status-import-success")).toHaveTextContent(
      "2 reports imported into your account.",
    );
  });

  it("keeps a rejected report available for review and requires ownership confirmation again before retrying", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    state.importLegacyReports
      .mockResolvedValueOnce({ ok: false, error: "Your access changed. Review the report and retry." })
      .mockResolvedValueOnce({ ok: true });
    mount();
    await openImportDialog();

    fireEvent.click(screen.getByTestId("checkbox-legacy-0"));
    fireEvent.change(screen.getByTestId("input-import-name-0"), { target: { value: "My receiving report" } });
    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    expect(await screen.findByTestId("error-legacy-import")).toHaveTextContent(
      "Your access changed. Review the report and retry.",
    );
    expect(screen.queryByTestId("status-import-success")).not.toBeInTheDocument();
    expect(screen.getByTestId("checkbox-legacy-0")).toBeChecked();
    expect(screen.getByTestId("input-import-name-0")).toHaveValue("My receiving report");
    expect(screen.getByTestId("checkbox-confirm-legacy-ownership")).not.toBeChecked();
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeDisabled();
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(originalStorage);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeEnabled();
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    await waitFor(() => expect(screen.getByTestId("status-import-success")).toBeInTheDocument());
    expect(state.importLegacyReports).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(originalStorage);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("keeps a report available and requires fresh confirmation after a connection failure", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    state.importLegacyReports
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true });
    mount();
    await openImportDialog();

    fireEvent.click(screen.getByTestId("checkbox-legacy-0"));
    fireEvent.change(screen.getByTestId("input-import-name-0"), { target: { value: "My receiving report" } });
    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    expect(await screen.findByTestId("error-legacy-import")).toHaveTextContent(
      "Could not reach the server. Your browser reports are unchanged.",
    );
    expect(screen.getByTestId("checkbox-legacy-0")).toBeChecked();
    expect(screen.getByTestId("input-import-name-0")).toHaveValue("My receiving report");
    expect(screen.getByTestId("checkbox-confirm-legacy-ownership")).not.toBeChecked();
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeDisabled();
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(originalStorage);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeEnabled();
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    await waitFor(() => expect(screen.getByTestId("status-import-success")).toBeInTheDocument());
    expect(state.importLegacyReports).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(originalStorage);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("refreshes the preview and requires new confirmation when another tab changes browser reports", async () => {
    mount();
    await openImportDialog();

    fireEvent.click(screen.getByTestId("checkbox-legacy-0"));
    fireEvent.change(screen.getByTestId("input-import-name-0"), { target: { value: "My receiving report" } });
    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));

    const changedReports = [
      { ...originalReports[0], name: "Changed in another tab" },
      originalReports[1],
    ];
    window.localStorage.setItem(LEGACY_REPORTS_KEY, JSON.stringify({ version: 1, reports: changedReports }));
    fireEvent.click(screen.getByTestId("button-confirm-legacy-import"));

    expect(state.importLegacyReports).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Browser reports changed");
    expect(screen.getByText("Changed in another tab")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-legacy-0")).not.toBeChecked();
    expect(screen.getByTestId("checkbox-confirm-legacy-ownership")).not.toBeChecked();
  });

  it.each(["account", "client"] as const)("clears selection and ownership confirmation after a %s change", async (changedIdentity) => {
    const { rerender } = mount();
    await openImportDialog();

    fireEvent.click(screen.getByTestId("checkbox-legacy-0"));
    fireEvent.click(screen.getByTestId("checkbox-confirm-legacy-ownership"));
    expect(screen.getByTestId("checkbox-legacy-0")).toBeChecked();
    expect(screen.getByTestId("checkbox-confirm-legacy-ownership")).toBeChecked();

    if (changedIdentity === "account") {
      state.user = { id: "account-b", primaryEmailAddress: { emailAddress: "b@example.test" } };
    } else {
      state.access = {
        data: { ...state.access.data, clientId: "client-b", clientName: "Client B" },
      };
    }
    rerender(<LegacyReportImport section={section} reports={existingReports} ready />);

    await waitFor(() => expect(screen.queryByTestId("dialog-legacy-import")).not.toBeInTheDocument());
    await openImportDialog();
    expect(screen.getByTestId("checkbox-legacy-0")).not.toBeChecked();
    expect(screen.getByTestId("checkbox-legacy-1")).not.toBeChecked();
    expect(screen.getByTestId("checkbox-confirm-legacy-ownership")).not.toBeChecked();
    expect(screen.getByTestId("button-confirm-legacy-import")).toBeDisabled();
  });
});
