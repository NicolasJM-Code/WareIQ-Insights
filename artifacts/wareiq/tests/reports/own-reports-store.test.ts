import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccessOwnReportInput } from "@workspace/api-client-react";

vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: { id: "isolated-report-owner" } }),
  useAuth: () => ({ userId: "isolated-report-owner", sessionId: "isolated-session", isLoaded: true }),
}));

import {
  createReport, updateReport, duplicateReport, deleteReport, useOwnReportsState,
  OWN_REPORTS_KEY, type OwnReport, type OwnReportInput, type SaveResult,
} from "../../src/lib/own-reports-store";

const input: OwnReportInput = {
  section: "inbound", name: "Receipts", description: "Ordered columns",
  dataset: "receipts", fields: ["supplier", "id"], sourceDefault: "inbound-1",
};
const legacyRaw = JSON.stringify({ version: 1, reports: [{
  ...input, id: "browser-original", createdAt: "2026-01-01", updatedAt: "2026-01-02",
}] });
const endpoint = "/api/access/own-reports";
const clients: QueryClient[] = [];
let saved: Map<string, OwnReport>;
let nextId: number;
let failure: "http" | "network" | undefined;
let listFailure: boolean;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function reportFrom(result: SaveResult): OwnReport {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.report) throw new Error("Expected a saved report");
  return result.report;
}
function mount() {
  // A fresh client deliberately has no cached reports: this models a reload.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return renderHook(() => useOwnReportsState(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
}
async function reload(expected: OwnReport[]) {
  const view = mount();
  await waitFor(() => {
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.status).toBe("ok");
    expect(view.result.current.reports).toEqual(expected);
  });
  view.unmount();
}

beforeEach(() => {
  saved = new Map();
  nextId = 0;
  failure = undefined;
  listFailure = false;
  // This is Vitest's disposable jsdom storage, never the preview browser.
  window.localStorage.clear();
  window.localStorage.setItem(OWN_REPORTS_KEY, legacyRaw);
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (path === "/api/access/me" && method === "GET") {
      return json({ status: "active", platformAdmin: false, canCreateOwnReports: true,
        clientId: "isolated-client", clientName: "Test client", reportIds: ["inbound-1"], sites: [] });
    }
    if (path === endpoint && method === "GET") {
      return listFailure ? json({ error: "Unavailable" }, 503) : json([...saved.values()]);
    }
    if ((path === endpoint && method === "POST") ||
        (path.startsWith(`${endpoint}/`) && method === "DELETE")) {
      if (failure === "network") throw new TypeError("Network unavailable");
      if (failure === "http") return json({ error: "The report could not be stored." }, 503);
      if (method === "DELETE") {
        saved.delete(path.slice(endpoint.length + 1));
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(String(init?.body)) as AccessOwnReportInput;
      const old = body.id ? saved.get(body.id) : undefined;
      const report: OwnReport = {
        ...body, section: body.section as OwnReport["section"],
        id: body.id ?? `isolated-report-${++nextId}`,
        createdAt: old?.createdAt ?? "2026-01-01T00:00:00Z",
        updatedAt: old ? "2026-01-02T00:00:00Z" : "2026-01-01T00:00:00Z",
      };
      saved.set(report.id, report);
      return json(report);
    }
    throw new Error(`Unexpected request in isolated report test: ${method} ${path}`);
  }));
});
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("server-backed own report persistence", () => {
  it("creates, edits, duplicates and deletes definitions across uncached reloads", async () => {
    const created = reportFrom(await createReport(input));
    expect(created).toMatchObject(input);
    await reload([created]);

    const { sourceDefault: _sourceDefault, ...withoutSource } = input;
    const editedInput = { ...withoutSource, name: "Edited receipts", description: "Updated",
      fields: ["id", "supplier"] };
    const edited = reportFrom(await updateReport(created.id, editedInput));
    expect(edited).toMatchObject({ ...editedInput, id: created.id, createdAt: created.createdAt });
    expect(edited).not.toHaveProperty("sourceDefault");
    expect(edited.updatedAt).not.toBe(created.updatedAt);
    await reload([edited]);

    const copy = reportFrom(await duplicateReport(edited));
    expect(copy.id).not.toBe(edited.id);
    expect(copy).toMatchObject({ ...editedInput, name: "Edited receipts (copy)" });
    await reload([edited, copy]);

    expect(await deleteReport(edited.id)).toEqual({ ok: true });
    await reload([copy]);
    expect(await deleteReport(copy.id)).toEqual({ ok: true });
    await reload([]);
    expect(window.localStorage.getItem(OWN_REPORTS_KEY)).toBe(legacyRaw);
  });

  it("does not send the original ID or timestamps when duplicating a long name", async () => {
    const original = reportFrom(await createReport({ ...input, name: "x".repeat(80) }));
    const copy = reportFrom(await duplicateReport(original));
    expect(copy.name).toBe(`${"x".repeat(68)} (copy)`);
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posts.at(-1)?.[1]?.body))).toEqual({
      ...input, name: copy.name,
    });
    await reload([original, copy]);
  });

  it("refreshes an already mounted list only after successful mutations", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const changed = vi.fn();
    window.addEventListener("wareiq-own-reports-changed", changed);
    try {
      let created!: OwnReport;
      await act(async () => { created = reportFrom(await createReport(input)); });
      await waitFor(() => expect(view.result.current.reports).toEqual([created]));
      let edited!: OwnReport;
      await act(async () => { edited = reportFrom(await updateReport(created.id, { ...input, name: "Edited" })); });
      await waitFor(() => expect(view.result.current.reports).toEqual([edited]));
      let copy!: OwnReport;
      await act(async () => { copy = reportFrom(await duplicateReport(edited)); });
      await waitFor(() => expect(view.result.current.reports).toEqual([edited, copy]));
      await act(async () => { expect(await deleteReport(copy.id)).toEqual({ ok: true }); });
      await waitFor(() => expect(view.result.current.reports).toEqual([edited]));
      expect(changed).toHaveBeenCalledTimes(4);
      failure = "http";
      await act(async () => { expect((await deleteReport(edited.id)).ok).toBe(false); });
      expect(view.result.current.reports).toEqual([edited]);
      expect(changed).toHaveBeenCalledTimes(4);
    } finally {
      window.removeEventListener("wareiq-own-reports-changed", changed);
    }
  });

  for (const mode of ["http", "network"] as const) {
    for (const operation of ["create", "edit", "duplicate", "delete"] as const) {
      it(`preserves existing definitions after a ${mode} failure during ${operation}`, async () => {
        const original = reportFrom(await createReport(input));
        const neighbour = reportFrom(await createReport({ ...input, name: "Other report" }));
        const changed = vi.fn();
        window.addEventListener("wareiq-own-reports-changed", changed);
        failure = mode;
        try {
          const result = await ({
            create: () => createReport({ ...input, name: "New" }),
            edit: () => updateReport(original.id, { ...input, name: "Changed" }),
            duplicate: () => duplicateReport(original),
            delete: () => deleteReport(original.id),
          }[operation])();
          expect(result).toEqual({ ok: false, error: mode === "http"
            ? "The report could not be stored."
            : "The report could not be saved. Check your permissions and try again." });
          expect(changed).not.toHaveBeenCalled();
          await reload([original, neighbour]);
          expect(window.localStorage.getItem(OWN_REPORTS_KEY)).toBe(legacyRaw);
        } finally {
          window.removeEventListener("wareiq-own-reports-changed", changed);
        }
      });
    }
  }

  for (const mode of ["blocked getter", "blocked read", "quota exceeded"] as const) {
    it(`keeps CRUD and reloads working with ${mode} browser storage`, async () => {
      const storage = window.localStorage;
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
      const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });
      const read = vi.spyOn(Storage.prototype, "getItem");
      if (mode === "blocked read") read.mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
      const getter = mode === "blocked getter"
        ? vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); })
        : undefined;
      const created = reportFrom(await createReport(input));
      await reload([created]);
      const edited = reportFrom(await updateReport(created.id, { ...input, name: "Edited" }));
      const copy = reportFrom(await duplicateReport(edited));
      await reload([edited, copy]);
      expect(await deleteReport(copy.id)).toEqual({ ok: true });
      await reload([edited]);
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      if (getter) expect(getter).not.toHaveBeenCalled();
      getter?.mockRestore();
      read.mockRestore();
      expect(storage.getItem(OWN_REPORTS_KEY)).toBe(legacyRaw);
    });
  }

  it("reports a failed reload explicitly and recovers without changing persisted reports", async () => {
    const original = reportFrom(await createReport(input));
    listFailure = true;
    const view = mount();
    await waitFor(() => expect(view.result.current.status).toBe("unavailable"));
    expect(view.result.current.detail).toMatch(/could not be loaded/);
    expect(saved.get(original.id)).toEqual(original);
    view.unmount();
    listFailure = false;
    await reload([original]);
  });
});
