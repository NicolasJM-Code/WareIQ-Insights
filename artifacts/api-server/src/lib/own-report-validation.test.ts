import { test } from "node:test";
import assert from "node:assert/strict";
import { reportDefinitionError } from "./own-report-validation";
import { ImportAccessOwnReportsBody, SaveAccessOwnReportBody } from "@workspace/api-zod";

const definition = { section: "inbound", name: "My receipts", dataset: "receipts", fields: ["id", "supplier"], description: "" };
test("an own report passes when its section is enabled for the role", () => {
  assert.equal(reportDefinitionError(definition, ["inbound-1"], ["inbound"]), undefined);
});
test("unauthorized and forged section grants are rejected", () => {
  for (const grants of [[], ["inventory-1"], ["inbound-injected"]]) {
    assert.equal(reportDefinitionError(definition, grants, [])?.status, 403);
  }
  assert.equal(reportDefinitionError(definition, ["inbound-1"], ["inventory"])?.status, 403);
});
test("unknown, cross-section and prototype datasets are rejected", () => {
  for (const dataset of ["stock", "missing", "__proto__", "constructor", "toString"]) {
    assert.equal(reportDefinitionError({ ...definition, dataset }, ["inbound-1"], ["inbound"])?.status, 400);
  }
});
test("unknown, empty and repeated columns are rejected, not silently dropped", () => {
  for (const fields of [[], ["secret"], ["id", "secret"], ["id", "id"]]) {
    assert.equal(reportDefinitionError({ ...definition, fields }, ["inbound-1"], ["inbound"])?.status, 400);
  }
});
test("source report permissions and blank names are checked", () => {
  assert.equal(reportDefinitionError({ ...definition, sourceDefault: "inventory-1" }, ["inbound-1"], ["inbound"])?.status, 403);
  assert.equal(reportDefinitionError({ ...definition, name: "  " }, ["inbound-1"], ["inbound"])?.status, 400);
});
test("imports require explicit confirmation and a bounded non-empty selection", () => {
  const input = { expectedOwnerId: "user-a", expectedClientId: "client-a", confirmedOwnership: true, reports: [definition] };
  assert.ok(ImportAccessOwnReportsBody.strict().safeParse(input).success);
  for (const overrides of [
    { confirmedOwnership: false }, { confirmedOwnership: undefined }, { expectedOwnerId: "" },
    { expectedClientId: "" }, { reports: [] }, { reports: Array(51).fill(definition) },
    { ownerId: "user-b" }, { id: "legacy-id" },
  ]) {
    assert.equal(ImportAccessOwnReportsBody.strict().safeParse({ ...input, ...overrides }).success, false);
  }
});
test("import definitions reject IDs, ownership, and unknown properties", () => {
  const schema = SaveAccessOwnReportBody.omit({ id: true }).strict();
  for (const extra of [{ id: "legacy" }, { ownerId: "other" }, { clientId: "other" }, { createdAt: "yesterday" }, { rows: [] }]) {
    assert.equal(schema.safeParse({ ...definition, ...extra }).success, false);
  }
  assert.equal(schema.safeParse({ ...definition, name: "x".repeat(81) }).success, false);
  assert.equal(schema.safeParse({ ...definition, fields: [] }).success, false);
});
