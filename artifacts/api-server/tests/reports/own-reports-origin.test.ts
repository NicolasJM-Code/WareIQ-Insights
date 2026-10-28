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
      publicMetadata: { role: "admin" },
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
  reports: [
    { ...definition, name: "Imported report A" },
    { ...definition, name: "Imported report B" },
    { ...definition, name: "Imported report C" },
  ],
};
const snapshot = async () =>
  (await pool.query("SELECT * FROM wareiq_own_reports ORDER BY id")).rows;
const clientSnapshot = async () =>
  (await pool.query("SELECT * FROM wareiq_clients ORDER BY id")).rows;
const siteSnapshot = async () =>
  (await pool.query("SELECT * FROM wareiq_sites ORDER BY id")).rows;

function mutation(
  method: "post" | "delete",
  url: string,
  options: {
    origin?: string;
    fetchSite?: string;
    forwardedHost?: string;
    forwardedProto?: string;
  } = {},
) {
  let req = request(app)[method](url)
    .set("Host", "wareiq.test")
    .set("X-Forwarded-Proto", options.forwardedProto ?? "https");
  if (options.forwardedHost !== undefined) req = req.set("X-Forwarded-Host", options.forwardedHost);
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
    DROP TRIGGER IF EXISTS concurrent_insert_barrier ON wareiq_own_reports;
    DROP FUNCTION IF EXISTS report_insert_barrier();
    DROP SEQUENCE IF EXISTS own_report_insert_barrier;
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
    ["malformed Origin", { origin: "not-an-origin" }],
    ["Origin with a path", { origin: "https://wareiq.test/reports" }],
    ["insecure HTTP Origin", { origin: "http://wareiq.test" }],
    ["mismatched fetch metadata", { origin: "https://wareiq.test", fetchSite: "cross-site" }],
    ["forwarded host chain with a different public host", {
      origin: "https://wareiq.test",
      forwardedHost: "attacker.test, wareiq.test",
    }],
    ["malformed forwarded host in the chain", {
      origin: "https://wareiq.test",
      forwardedHost: "wareiq.test, attacker.test/",
    }],
    ["malformed forwarded host authority", {
      origin: "https://attacker.test",
      forwardedHost: "wareiq.test@attacker.test",
    }],
    ["conflicting forwarded protocols", {
      origin: "https://wareiq.test",
      forwardedProto: "https, http",
    }],
    ["malformed forwarded protocol", {
      origin: "https://wareiq.test",
      forwardedProto: "https;attacker=true",
    }],
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
      forwardedHost: "wareiq.test, internal.test",
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

  it("allows a same-origin bulk import through the full application", async () => {
    const before = await snapshot();
    const response = await mutation("post", importPath, {
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    }).send(importBody);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(importBody.reports.length);
    for (const importedDefinition of importBody.reports) {
      expect(response.body).toContainEqual(expect.objectContaining({
        ...importedDefinition,
        id: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }));
    }

    const after = await snapshot();
    expect(after).toHaveLength(before.length + importBody.reports.length);
    const importedIds = new Set(response.body.map((report: { id: string }) => report.id));
    expect(importedIds).toHaveLength(importBody.reports.length);
    const persistedImports = after.filter((row) => importedIds.has(row.id));
    expect(persistedImports).toHaveLength(importBody.reports.length);
    for (const importedDefinition of importBody.reports) {
      const returned = response.body.find(
        (report: { name: string }) => report.name === importedDefinition.name,
      );
      expect(returned).toBeDefined();
      expect(persistedImports.find((row) => row.id === returned.id)).toMatchObject({
        owner_id: "owner-a",
        client_id: "client-a",
        definition: importedDefinition,
      });
    }
  });

  it("rejects a conflicting same-origin batch without persisting any reports", async () => {
    const before = await snapshot();
    const response = await mutation("post", importPath, {
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    }).send({
      ...importBody,
      reports: [
        { ...definition, name: "Would be partially imported" },
        { ...definition, name: "Same-origin report" },
      ],
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "This entry already exists. Use a unique name or email.",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back every report in the losing concurrent same-origin import", async () => {
    const before = await snapshot();
    await pool.query(`
      CREATE SEQUENCE own_report_insert_barrier;
      CREATE FUNCTION report_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        ticket bigint;
        attempt integer;
      BEGIN
        ticket := nextval('own_report_insert_barrier');
        IF ticket <= 2 THEN
          FOR attempt IN 1..500 LOOP
            EXIT WHEN (SELECT last_value FROM own_report_insert_barrier) >= 2;
            PERFORM pg_sleep(0.01);
          END LOOP;
          IF (SELECT last_value FROM own_report_insert_barrier) < 2 THEN
            RAISE EXCEPTION 'Concurrent report import barrier timed out';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER concurrent_insert_barrier BEFORE INSERT ON wareiq_own_reports
        FOR EACH ROW EXECUTE FUNCTION report_insert_barrier();
    `);

    const firstBatch = [
      { ...definition, name: "First batch only before conflict" },
      { ...definition, name: "Concurrent shared report" },
      { ...definition, name: "First batch only after conflict" },
    ];
    const secondBatch = [
      { ...definition, name: "Second batch only before conflict" },
      { ...definition, name: "Concurrent shared report" },
      { ...definition, name: "Second batch only after conflict" },
    ];
    const sameOrigin = { origin: "https://wareiq.test", fetchSite: "same-origin" };
    const [first, second] = await Promise.all([
      mutation("post", importPath, sameOrigin).send({ ...importBody, reports: firstBatch }),
      mutation("post", importPath, sameOrigin).send({ ...importBody, reports: secondBatch }),
    ]);

    const success = first.status === 200 ? first : second;
    const conflict = first.status === 409 ? first : second;
    const winningBatch = first.status === 200 ? firstBatch : secondBatch;
    const losingBatch = first.status === 409 ? firstBatch : secondBatch;
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(conflict.body).toEqual({
      error: "This entry already exists. Use a unique name or email.",
    });
    expect(success.body).toHaveLength(winningBatch.length);
    expect(success.body.map((report: { name: string }) => report.name))
      .toEqual(winningBatch.map((report) => report.name));

    const after = await snapshot();
    expect(after).toHaveLength(before.length + winningBatch.length);
    const persistedNames = after
      .filter((row) => row.owner_id === "owner-a" && row.client_id === "client-a")
      .map((row) => row.definition.name);
    for (const report of winningBatch) expect(persistedNames).toContain(report.name);
    for (const report of losingBatch) {
      if (report.name !== "Concurrent shared report") expect(persistedNames).not.toContain(report.name);
    }
  }, 15_000);

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

describe("full-app origin protection for other persistent API changes", () => {
  const clientBody = {
    name: "Origin regression client",
    companyNumber: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    active: true,
  };
  const warehouseBody = {
    clientId: "client-a",
    sourceId: "origin-regression-site",
    name: "Origin regression warehouse",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    contactPhone: "",
    active: true,
  };
  const persistentMutations = [
    { path: "/api/access/clients", body: clientBody, snapshot: clientSnapshot },
    { path: "/api/access/warehouses", body: warehouseBody, snapshot: siteSnapshot },
  ];

  it.each([
    ["absent Origin", {}],
    ["foreign Origin", { origin: "https://foreign.test" }],
    ["mismatched fetch metadata", { origin: "https://wareiq.test", fetchSite: "cross-site" }],
  ] as const)("blocks non-report changes with %s before changing persistent state", async (_label, options) => {
    for (const route of persistentMutations) {
      const before = await route.snapshot();
      const response = await mutation("post", route.path, options).send(route.body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "A same-origin request is required." });
      expect(await route.snapshot()).toEqual(before);
    }
  });

  it("allows same-origin creation on non-report routes through the full application", async () => {
    const validOrigin = { origin: "https://wareiq.test", fetchSite: "same-origin" };
    for (const route of persistentMutations) {
      const before = await route.snapshot();
      const response = await mutation("post", route.path, validOrigin).send(route.body);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ...route.body, id: expect.any(String) });
      const after = await route.snapshot();
      expect(after).toHaveLength(before.length + 1);
      expect(after.find((row) => row.id === response.body.id)).toBeDefined();
    }
  });
});
