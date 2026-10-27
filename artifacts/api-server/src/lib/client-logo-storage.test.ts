import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupClientLogoBestEffort, deleteClientLogoIfUnreferenced, isClientLogoPath,
} from "./client-logo-storage";

const clientA = "3ed2c922-b996-44e4-8d9f-929d522026b2";
const clientB = "61f1fc93-e6a9-4e9d-822d-d8663cfe5a18";
const logoA = `/objects/client-logos/${clientA}/9fa7be17-1a8f-4e13-9a21-f8083878b404.png`;

test("client logo object paths are private and scoped to exactly one client", () => {
  assert.equal(isClientLogoPath(clientA, logoA), true);
  assert.equal(isClientLogoPath(clientB, logoA), false);
  assert.equal(isClientLogoPath(clientA, logoA.replace(".png", ".svg")), false);
  assert.equal(isClientLogoPath(clientA, logoA.replace(clientA, `${clientA}/../${clientB}`)), false);
  assert.equal(isClientLogoPath("not-a-uuid", logoA), false);
});

test("client logo cleanup skips an object still referenced by another client", async () => {
  const clients = [
    { id: clientA, logoPath: null as string | null },
    { id: clientB, logoPath: logoA },
  ];
  const deleted: string[] = [];
  const removed = await deleteClientLogoIfUnreferenced(
    clientA,
    logoA,
    async (path) => clients.some((client) => client.logoPath === path),
    async (_clientId, path) => { deleted.push(path); },
  );

  assert.equal(removed, false);
  assert.deepEqual(deleted, []);
});

test("client logo cleanup deletes an unreferenced object after the caller's save", async () => {
  const deleted: string[] = [];
  const removed = await deleteClientLogoIfUnreferenced(
    clientA,
    logoA,
    async () => false,
    async (_clientId, path) => { deleted.push(path); },
  );

  assert.equal(removed, true);
  assert.deepEqual(deleted, [logoA]);
});

test("client logo cleanup failures are reported without escaping the best-effort cleanup", async () => {
  let reported = false;
  const removed = await cleanupClientLogoBestEffort(
    clientA,
    logoA,
    async () => false,
    () => { reported = true; },
    async () => { throw new Error("storage unavailable"); },
  );

  assert.equal(removed, false);
  assert.equal(reported, true);
});
