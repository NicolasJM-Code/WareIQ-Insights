import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { accessReports, allowedSection, sectionDatasets } from "./access-catalog";

const root = resolve(process.cwd(), "../..");
test("permission names and IDs match the approved name-only report catalogue", () => {
  const specification = readFileSync(resolve(root,
    "attached_assets/Pasted-1-Executive-Dashboard-Warehouse-Performance-Summary-Dai_1793099471452.txt"), "utf8");
  const sections = ["dashboard", "inbound", "putaway", "inventory", "picking", "outbound",
    "dispatch", "traceability", "stock-counts", "labour", "exceptions", "settings"];
  const expected = specification.trim().split(/^\d+\.\s+/m).filter(Boolean).flatMap((part, i) =>
    part.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line, j) =>
      ({ id: `${sections[i]}-${j + 1}`, name: line.slice(2).trim(), section: sections[i] })));
  assert.deepEqual(accessReports.map(({ id, name, section }) => ({ id, name, section })), expected);
});
test("custom report server field allowlists match each existing section dataset", () => {
  const source = readFileSync(resolve(root, "artifacts/wareiq/src/lib/report-catalog.ts"), "utf8");
  const fields = new Map<string, string[]>();
  for (const block of source.matchAll(/const \w+ = dataset(?:<[^>]+>)?\(\{([\s\S]*?)\n\}\);/g)) {
    const id = block[1].match(/id:\s*'([^']+)'/)?.[1];
    if (!id) continue;
    const keys = [...block[1].matchAll(/(?:fld|dx)(?:<[^>]+>)?\(\s*'([^']+)'/g)].map((m) => m[1]);
    if (block[1].includes("whF<")) keys.push("wh");
    fields.set(id, keys);
  }
  assert.ok(fields.size >= 10, "Test must discover the frontend dataset definitions");
  for (const [section, datasets] of Object.entries(sectionDatasets)) {
    for (const [dataset, allowed] of Object.entries(datasets)) {
      assert.ok(fields.has(dataset), `Dataset ${section}/${dataset} exists`);
      assert.deepEqual([...new Set(allowed)].sort(), [...new Set(fields.get(dataset))].sort(), `${section}/${dataset}`);
    }
  }
});
test("a section grant cannot be forged with a report-ID prefix or unknown report", () => {
  assert.equal(allowedSection(["inbound-1"], "inbound"), true);
  assert.equal(allowedSection(["inbound-1"], "inventory"), false);
  assert.equal(allowedSection(["inventory-injected"], "inventory"), false);
  assert.equal(allowedSection([], "inbound"), false);
});
