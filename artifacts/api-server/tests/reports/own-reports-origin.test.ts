import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  assertFixtureIsolation,
  configureReportFixtureSuite,
  db,
  pool,
  startDatabase,
  stopDatabase,
  waitForPeerFixture,
} from "./database";
import { ownReportsTable } from "@workspace/db/schema";

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: () => ({ userId: "owner-a", sessionId: "report-session" }),
  clerkClient: {
    sessions: { getSession: async () => ({ status: "active", userId: "owner-a" }) },
    users: { getUser: async () => ({
      banned: false,
      locked: false,
      publicMetadata: {},
      primaryEmailAddressId: "verified",
      emailAddresses: [{
        id: "verified",
        emailAddress: "reporter@example.test",
        verification: { status: "verified" },
      }],
    }) },
  },
}));
vi.mock("@clerk/shared/keys", () => ({ publishableKeyFromHost: () => "isolated-test-key" }));
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: (await import("./database")).db,
}));
vi.mock("pino-http", () => ({
  default: () => (req: { log: unknown }, _res: unknown, next: () => void) => {
    req.log = { error: () => undefined, warn: () => undefined };
    next();
  },
}));
vi.mock("../../src/lib/logger", () => ({ logger: {} }));

import app from "../../src/app";

const path = "/api/access/own-reports";
const importPath = `${path}/import`;
const definition = {
  section: "inbound",
  dataset: "receipts",
  fields: ["id", "supplier"],
  name: "Same-origin report",
  description: "Created through the full application",
};
const importBody = {
  expectedOwnerId: "owner-a",
  expectedClientId: "client-a",
  confirmedOwnership: true,
  reports: [{ ...definition, name: "Imported report" }],
};
const snapshot = async () =>
  (await pool.query("SELECT * FROM wareiq_own_reports ORDER BY id")).rows;

function mutation(
  method: "post" | "delete",
  url: string,
  options: { origin?: string; fetchSite?: string } = {},
) {
  let req = request(app)[method](url)
    .set("Host", "wareiq.test")
    .set("X-Forwarded-Proto", "https");
  if (options.origin !== undefined) req = req.set("Origin", options.origin);
  if (options.fetchSite !== undefined) req = req.set("Sec-Fetch-Site", options.fetchSite);
  return req;
}

configureReportFixtureSuite("own-reports-origin");
beforeAll(async () => {
  await startDatabase();
  await waitForPeerFixture();
});
afterAll(stopDatabase);
beforeEach(async () => {
  await pool.query(`
    TRUNCATE wareiq_own_reports, wareiq_members, wareiq_sites, wareiq_roles, wareiq_clients;
    INSERT INTO wareiq_clients VALUES ('client-a', 'Synthetic A', true), ('client-b', 'Synthetic B', true);
    INSERT INTO wareiq_sites VALUES ('site-a', 'client-a', 'test', 'Synthetic site', true);
    INSERT INTO wareiq_roles VALUES ('role-a', 'client-a', 'Builder', ARRAY['inbound-1'], true, ARRAY['inbound']);
    INSERT INTO wareiq_members VALUES ('member-a', 'reporter@example.test', 'Synthetic reporter',
      'client-a', 'role-a', ARRAY['site-a'], 'site-a', true);
  `);
  await db.insert(ownReportsTable).values([
    { id: "original", ownerId: "owner-a", clientId: "client-a", definition },
    { id: "neighbour", ownerId: "owner-a", clientId: "client-a", definition: { ...definition, name: "Neighbour" } },
    { id: "other-owner", ownerId: "owner-b", clientId: "client-a", definition },
    { id: "other-client", ownerId: "owner-a", clientId: "client-b", definition },
  ]);
});

describe("full-app origin protection for saved reports", () => {
  it("keeps its PostgreSQL fixture private from the API suite", async () => {
    await assertFixtureIsolation();
  });

  const rejectedRequests = [
    ["absent Origin", {}],
    ["foreign Origin", { origin: "https://foreign.test" }],
    ["mismatched fetch metadata", { origin: "https://wareiq.test", fetchSite: "cross-site" }],
  ] as const;

  it.each(rejectedRequests)("blocks POST with %s and preserves every report row", async (_label, options) => {
    const before = await snapshot();
    const response = await mutation("post", path, options).send(definition);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "A same-origin request is required." });
    expect(await snapshot()).toEqual(before);
  });

  it.each(rejectedRequests)("blocks report import with %s and preserves every report row", async (_label, options) => {
    const before = await snapshot();
    const response = await mutation("post", importPath, options).send(importBody);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "A same-origin request is required." });
    expect(await snapshot()).toEqual(before);
  });

  it.each(rejectedRequests)("blocks DELETE with %s and preserves every report row", async (_label, options) => {
    const before = await snapshot();
    const response = await mutation("delete", `${path}/original`, options);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "A same-origin request is required." });
    expect(await snapshot()).toEqual(before);
  });

  it("allows a same-origin POST to create a report through the full application", async () => {
    const before = await snapshot();
    const createdDefinition = { ...definition, name: "New same-origin report" };
    const response = await mutation("post", path, {
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    }).send(createdDefinition);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...createdDefinition, id: expect.any(String) });
    const after = await snapshot();
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((row) => row.id === response.body.id)).toMatchObject({
      owner_id: "owner-a",
      client_id: "client-a",
      definition: createdDefinition,
    });
  });

  it("allows a same-origin DELETE to remove a report through the full application", async () => {
    const before = await snapshot();
    const response = await mutation("delete", `${path}/original`, {
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(204);
    expect((await snapshot()).map((row) => row.id)).toEqual(
      before.map((row) => row.id).filter((id) => id !== "original"),
    );
  });
});
