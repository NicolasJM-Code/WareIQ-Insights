import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { db, pool, startDatabase, stopDatabase } from "./database";
import { ownReportsTable } from "@workspace/db/schema";

const identity = vi.hoisted(() => ({ userId: "owner-a" as string | null, error: vi.fn() }));
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: (await import("./database")).db,
}));
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: identity.userId }),
  clerkClient: { users: { getUser: async () => ({
    banned: false, locked: false, publicMetadata: {},
    primaryEmailAddressId: "verified",
    emailAddresses: [{ id: "verified", emailAddress: "reporter@example.test", verification: { status: "verified" } }],
  }) } },
}));
import accessRouter from "../../src/routes/access";

// Exercise the actual router, Zod validators, membership checks, Drizzle writes,
// SQL constraints and PostgreSQL rollback. Clerk alone is simulated.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.log = { error: identity.error } as unknown as typeof req.log;
  next();
});
app.use("/api", accessRouter);
const path = "/api/access/own-reports";
const definition = {
  section: "inbound", dataset: "receipts", fields: ["id", "supplier"],
  name: "Original", description: "Keep this definition",
};
const snapshot = async () => (await pool.query("SELECT * FROM wareiq_own_reports ORDER BY id")).rows;
const save = (body: unknown) => request(app).post(path).send(body as object);

async function expectError(response: request.Response, status: number, before: unknown) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: expect.any(String) });
  expect(response.body.error.length).toBeGreaterThan(0);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(await snapshot()).toEqual(before);
}

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  identity.userId = "owner-a";
  identity.error.mockClear();
  await pool.query(`
    DROP TRIGGER IF EXISTS injected_fault ON wareiq_own_reports;
    DROP FUNCTION IF EXISTS report_fault();
    TRUNCATE wareiq_own_reports, wareiq_members, wareiq_sites, wareiq_roles, wareiq_clients;
    INSERT INTO wareiq_clients VALUES ('client-a', 'Synthetic A', true), ('client-b', 'Synthetic B', true);
    INSERT INTO wareiq_sites VALUES ('site-a', 'client-a', 'test', 'Synthetic site', true);
    INSERT INTO wareiq_roles VALUES ('role-a', 'client-a', 'Builder', ARRAY['inbound-1'], true);
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

describe("account report persistence through the API", () => {
  it("creates, edits and deletes only the requested account row, with a fresh GET after each write", async () => {
    const before = await snapshot();
    const created = await save({ ...definition, name: "  New report  " });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ...definition, name: "New report", id: expect.any(String),
      createdAt: expect.any(String), updatedAt: expect.any(String) });
    const stored = (await snapshot()).find((row) => row.id === created.body.id);
    expect(stored).toMatchObject({ owner_id: "owner-a", client_id: "client-a" });
    expect((await request(app).get(path)).body).toContainEqual(created.body);
    const updated = await save({ ...definition, id: "original", name: "Edited", fields: ["supplier", "id"] });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: "original", name: "Edited", fields: ["supplier", "id"],
      createdAt: before.find((row) => row.id === "original").created_at.toISOString() });
    expect((await request(app).get(path)).body).toContainEqual(updated.body);
    expect((await request(app).delete(`${path}/original`)).status).toBe(204);
    const reports = await request(app).get(path);
    expect(reports.status).toBe(200);
    expect(reports.body.map((row: { id: string }) => row.id).sort()).toEqual([created.body.id, "neighbour"].sort());
    expect((await snapshot()).filter((row) => row.id !== created.body.id))
      .toEqual(before.filter((row) => row.id !== "original"));
  });

  it.each([
    ["empty name", { name: "   " }, 400],
    ["unknown field", { fields: ["customer-secret"] }, 400],
    ["duplicate field", { fields: ["id", "id"] }, 400],
    ["wrong dataset", { dataset: "locations" }, 400],
    ["no fields", { fields: [] }, 400],
    ["forbidden section", { section: "inventory" }, 403],
    ["forbidden source", { sourceDefault: "inbound-2" }, 403],
    ["forged owner", { ownerId: "owner-b" }, 400],
    ["forged client", { clientId: "client-b" }, 400],
    ["forged timestamp", { createdAt: new Date(0).toISOString() }, 400],
    ["malformed name", { name: null }, 400],
  ])("rejects %s for both create and edit without altering any row", async (_label, patch, status) => {
    const before = await snapshot();
    for (const id of [undefined, "original"]) {
      await expectError(await save({ ...definition, name: "New", ...(id ? { id } : {}), ...patch }), status, before);
    }
  });

  it("rejects duplicate names on create and edit but allows keeping a report's own name", async () => {
    const before = await snapshot();
    await expectError(await save({ ...definition, name: "  ORIGINAL  " }), 409, before);
    await expectError(await save({ ...definition, id: "original", name: " neighbour " }), 409, before);
    expect((await save({ ...definition, id: "original" })).status).toBe(200);
  });

  it.each(["other-owner", "other-client", "missing"])("cannot edit or delete %s", async (id) => {
    const before = await snapshot();
    await expectError(await save({ ...definition, name: "Attempted edit", id }), 404, before);
    await expectError(await request(app).delete(`${path}/${id}`), 404, before);
  });

  it.each(["permission", "section", "disabled", "signed-out"])("denies mutations after %s access is lost", async (change) => {
    if (change === "permission") await pool.query("UPDATE wareiq_roles SET can_create_own_reports = false");
    if (change === "section") await pool.query("UPDATE wareiq_roles SET report_ids = ARRAY['inventory-1']");
    if (change === "disabled") await pool.query("UPDATE wareiq_members SET active = false");
    if (change === "signed-out") identity.userId = null;
    const before = await snapshot();
    const status = change === "signed-out" ? 401 : 403;
    await expectError(await save({ ...definition, name: "New" }), status, before);
    await expectError(await save({ ...definition, id: "original" }), status, before);
    await expectError(await request(app).delete(`${path}/original`), status, before);
  });

  it.each(["INSERT", "UPDATE", "DELETE"])("rolls back a failed %s including trigger side effects and can retry", async (operation) => {
    const before = await snapshot();
    // Fail AFTER the write, not before reaching PostgreSQL. Updating a second
    // row proves the entire statement's transaction rolls back on failure.
    await pool.query(`
      CREATE FUNCTION report_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 THEN
          UPDATE wareiq_own_reports SET definition = definition || '{"description":"must roll back"}'
            WHERE id = 'neighbour';
          RAISE EXCEPTION 'private SQL detail for synthetic owner' USING ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER injected_fault AFTER ${operation} ON wareiq_own_reports
        FOR EACH ROW EXECUTE FUNCTION report_fault();
    `);
    const mutate = () => operation === "DELETE" ? request(app).delete(`${path}/original`)
      : save({ ...definition, name: "Changed", ...(operation === "UPDATE" ? { id: "original" } : {}) });
    const response = await mutate();
    await expectError(response, 503, before);
    expect(response.body).toEqual({ error: "Access settings are temporarily unavailable. Please retry." });
    expect(identity.error).toHaveBeenCalledWith({ event: "access_request_failed" }, "Access request failed");
    expect(JSON.stringify(identity.error.mock.calls)).not.toContain("private SQL");
    const listed = await request(app).get(path);
    expect(listed.status).toBe(200);
    expect(listed.body.find((row: { id: string }) => row.id === "original")).toMatchObject(definition);
    await pool.query("DROP TRIGGER injected_fault ON wareiq_own_reports");
    expect((await mutate()).status).toBe(operation === "DELETE" ? 204 : 200);
  });

  it.each(["INSERT", "UPDATE"])("returns 409 and rolls back a real unique constraint failure after %s preflight", async (operation) => {
    const before = await snapshot();
    // The API preflight sees no duplicate. An AFTER trigger then inserts a
    // colliding name, causing the actual unique expression index to reject it.
    await pool.query(`
      CREATE FUNCTION report_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 THEN
          INSERT INTO wareiq_own_reports (id, owner_id, client_id, definition)
            VALUES ('collision', NEW.owner_id, NEW.client_id, NEW.definition);
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER injected_fault AFTER ${operation} ON wareiq_own_reports
        FOR EACH ROW EXECUTE FUNCTION report_fault();
    `);
    const response = await save({ ...definition, name: "Changed",
      ...(operation === "UPDATE" ? { id: "original" } : {}) });
    await expectError(response, 409, before);
    expect(response.body).toEqual({ error: "This entry already exists. Use a unique name or email." });
  });
});
