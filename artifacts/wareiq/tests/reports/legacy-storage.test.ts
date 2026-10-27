import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCorruptLegacyReports, LEGACY_REPORTS_KEY, readLegacyReports } from "../../src/lib/legacy-report-import";

const report = {
  id: "browser-original", section: "inbound", name: "Receipts", description: "My columns",
  dataset: "receipts", fields: ["supplier", "id"], createdAt: "2026-01-01", updatedAt: "2026-01-02",
};
const encode = (reports: unknown[]) => JSON.stringify({ version: 1, reports });
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Legacy preview must not access the network"); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function previewWithoutMutation(raw: string) {
  window.localStorage.setItem(LEGACY_REPORTS_KEY, raw);
  const set = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const clear = vi.spyOn(Storage.prototype, "clear");
  const first = readLegacyReports();
  expect(readLegacyReports()).toEqual(first);
  expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(raw);
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  return first;
}

describe("read-only legacy browser storage", () => {
  it("treats absent storage as empty without initializing or deleting anything", () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(readLegacyReports()).toEqual({ candidates: [], invalid: 0 });
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("previews ordered definitions while dropping legacy identity and row data", () => {
    const preview = previewWithoutMutation(encode([{
      ...report, name: "  Receipts  ", ownerId: "untrusted", clientId: "untrusted",
      rows: [{ privateValue: "never import rows" }], sourceDefault: "inbound-1",
    }]));
    expect(preview).toEqual({ invalid: 0, candidates: [{ index: 0, input: {
      section: "inbound", name: "Receipts", description: "My columns",
      dataset: "receipts", fields: ["supplier", "id"], sourceDefault: "inbound-1",
    } }] });
  });

  const corruptCases = [
    ["malformed JSON", "{broken"],
    ["null", "null"],
    ["array envelope", "[]"],
    ["incompatible version", JSON.stringify({ version: 2, reports: [report] })],
    ["missing version", JSON.stringify({ reports: [report] })],
    ["non-array reports", JSON.stringify({ version: 1, reports: {} })],
    ["oversized text", "x".repeat(2_000_001)],
    ["too many reports", encode(Array(1001).fill(report))],
  ];
  it.each(corruptCases)("preserves %s verbatim rather than silently cleaning it up", (_name, raw) => {
    const preview = previewWithoutMutation(raw);
    expect(preview.candidates).toEqual([]);
    expect(preview.error).toMatch(/unchanged/);
  });

  const invalidDefinitions: [string, unknown][] = [
    ["null", null], ["primitive", 7], ["missing properties", {}],
    ["empty id", { ...report, id: "" }], ["missing createdAt", { ...report, createdAt: undefined }],
    ["invalid updatedAt", { ...report, updatedAt: 1 }], ["invalid section", { ...report, section: null }],
    ["blank name", { ...report, name: " " }], ["long name", { ...report, name: "x".repeat(81) }],
    ["long description", { ...report, description: "x".repeat(1001) }],
    ["invalid description", { ...report, description: {} }], ["empty dataset", { ...report, dataset: "" }],
    ["invalid source", { ...report, sourceDefault: {} }], ["missing fields", { ...report, fields: undefined }],
    ["empty fields", { ...report, fields: [] }], ["duplicate fields", { ...report, fields: ["id", "id"] }],
    ["non-string field", { ...report, fields: [null] }],
    ["too many fields", { ...report, fields: Array.from({ length: 101 }, (_, i) => `field-${i}`) }],
  ];
  it.each(invalidDefinitions)("counts %s without discarding valid neighbours", (_name, invalid) => {
    const preview = previewWithoutMutation(encode([report, invalid, { ...report, id: "other" }]));
    expect(preview.error).toBeUndefined();
    expect(preview.invalid).toBe(1);
    expect(preview.candidates.map(({ index }) => index)).toEqual([0, 2]);
  });

  it.each(["getter", "read"] as const)("reports blocked storage %s without overwriting originals", (mode) => {
    const raw = encode([report]);
    window.localStorage.setItem(LEGACY_REPORTS_KEY, raw);
    const set = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const blocked = () => { throw new DOMException("Blocked", "SecurityError"); };
    const fault = mode === "getter"
      ? vi.spyOn(window, "localStorage", "get").mockImplementation(blocked)
      : vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    expect(readLegacyReports()).toEqual({
      candidates: [], invalid: 0,
      error: "Browser storage is blocked or unavailable. Originals are unchanged.",
    });
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    fault.mockRestore();
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(raw);
  });

  it("clears exactly the unreadable snapshot only after explicit confirmation", () => {
    const raw = "{broken";
    window.localStorage.setItem(LEGACY_REPORTS_KEY, raw);
    expect(readLegacyReports().corruptRaw).toBe(raw);
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(clearCorruptLegacyReports(raw, false).ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(raw);
    expect(clearCorruptLegacyReports(raw, true)).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith(LEGACY_REPORTS_KEY);
    expect(readLegacyReports()).toEqual({ candidates: [], invalid: 0 });
  });

  it("does not clear unsupported formats or a valid definition, even with confirmation", () => {
    for (const raw of [encode([report]), JSON.stringify({ version: 2, reports: [report] }),
      JSON.stringify({ version: 1, reports: {} }), "x".repeat(2_000_001)]) {
      window.localStorage.setItem(LEGACY_REPORTS_KEY, raw);
      const remove = vi.spyOn(Storage.prototype, "removeItem");
      expect(clearCorruptLegacyReports(raw, true).ok).toBe(false);
      expect(remove).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(raw);
      remove.mockRestore();
    }
  });

  it("refuses cleanup when another tab has changed the previewed data", () => {
    const raw = "{broken";
    window.localStorage.setItem(LEGACY_REPORTS_KEY, raw);
    expect(readLegacyReports().corruptRaw).toBe(raw);
    const replacement = encode([report]);
    window.localStorage.setItem(LEGACY_REPORTS_KEY, replacement);
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(clearCorruptLegacyReports(raw, true)).toEqual({
      ok: false, error: "Browser reports changed since preview. Review them again before deleting.",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(replacement);
  });

  it("reports a blocked deletion without claiming to have removed originals", () => {
    const raw = "{broken";
    window.localStorage.setItem(LEGACY_REPORTS_KEY, raw);
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    expect(clearCorruptLegacyReports(raw, true)).toEqual({
      ok: false, error: "Browser storage could not be cleared. Originals may still be present.",
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(LEGACY_REPORTS_KEY)).toBe(raw);
  });
});
