import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { auditedRoleChange, type AccessAuditStore } from "../src/lib/audited-role-change";
import { AccessConflict } from "../src/lib/role-management";

const audit = vi.hoisted(() => ({
  start: vi.fn(), previous: vi.fn(), finish: vi.fn(), page: vi.fn(),
  actorId: "user_actor", actorRole: "admin", verified: true, banned: false,
  getUser: vi.fn(), getUserList: vi.fn(), updateUserMetadata: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("../src/lib/access-history", () => ({
  accessAuditStore: { start: audit.start, previous: audit.previous, finish: audit.finish },
  accessHistoryPage: audit.page,
}));
vi.mock("../src/lib/role-lock", () => ({ withRoleLock: audit.lock }));
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: audit.actorId }),
  clerkClient: { users: { getUser: audit.getUser, getUserList: audit.getUserList, updateUserMetadata: audit.updateUserMetadata } },
}));

import adminRouter from "../src/routes/admin-users";
import { requireIdentity, requireAdministrator } from "../src/middlewares/access";

type Directory = Parameters<typeof auditedRoleChange>[2];
type User = Awaited<ReturnType<Directory["getUser"]>>;
function user(id: string, role: string, verified = true, banned = false): User {
  return {
    id, firstName: "Test", lastName: "Account", primaryEmailAddressId: "email_id",
    emailAddresses: [{ id: "email_id", emailAddress: "private@example.test", verification: { status: verified ? "verified" : "unverified" } }],
    publicMetadata: { role, secret: "metadata_must_not_be_saved" }, banned, locked: false,
  } as unknown as User;
}
const directory = {
  getUser: audit.getUser, getUserList: audit.getUserList, updateUserMetadata: audit.updateUserMetadata,
} as unknown as Directory;
const store = { start: audit.start, previous: audit.previous, finish: audit.finish } satisfies AccessAuditStore;
const lock = async <T>(run: () => Promise<T>) => run();
const run = (role: "admin" | "unassigned" = "admin", expected: "admin" | "unassigned" = "unassigned") =>
  auditedRoleChange(store, lock, directory, "user_actor", "user_target", role, expected);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.log = { warn: vi.fn() } as unknown as typeof req.log; next(); });
app.use("/api", requireIdentity);
app.use("/api/admin", requireAdministrator);
app.use("/api", adminRouter);

beforeEach(() => {
  vi.resetAllMocks();
  audit.actorId = "user_actor"; audit.actorRole = "admin"; audit.verified = true; audit.banned = false;
  audit.start.mockResolvedValue("c747e2d6-7ca8-4558-8af5-3c59ff419a46");
  audit.previous.mockResolvedValue(undefined);
  audit.finish.mockResolvedValue(undefined);
  audit.lock.mockImplementation(lock);
  audit.getUser.mockImplementation(async (id: string) => id === audit.actorId
    ? user(id, audit.actorRole, audit.verified, audit.banned) : user(id, "unassigned"));
  audit.updateUserMetadata.mockImplementation(async (id: string, body: { publicMetadata: { role: string } }) => user(id, body.publicMetadata.role));
  audit.getUserList.mockResolvedValue({ data: [user("user_actor", "admin")], totalCount: 1 });
  audit.page.mockResolvedValue({ entries: [], nextCursor: null });
});

describe("durable role change outcomes", () => {
  it("commits minimal intent and observed old role before the provider write", async () => {
    audit.updateUserMetadata.mockImplementation(async () => {
      expect(audit.start).toHaveBeenCalledWith({ actorId: "user_actor", targetId: "user_target", requestedRole: "admin" });
      expect(audit.previous).toHaveBeenCalledWith(expect.any(String), "unassigned");
      return user("user_target", "admin");
    });
    await run();
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "succeeded", "role_confirmed", "admin");
    expect(JSON.stringify([audit.start.mock.calls, audit.previous.mock.calls, audit.finish.mock.calls])).not.toMatch(/metadata_must|private@example/);
  });
  it("fails closed if the intent cannot be saved", async () => {
    audit.start.mockRejectedValue(new Error("database unavailable"));
    await expect(run()).rejects.toThrow();
    expect(audit.getUser).not.toHaveBeenCalled();
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
  });
  it("does not update Clerk if recording the observed role fails", async () => {
    audit.previous.mockRejectedValue(new Error("database unavailable"));
    await expect(run()).rejects.toThrow();
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "failed", "change_not_started");
  });
  it("records stale confirmation as denied with the real old role, not the browser's expectation", async () => {
    await expect(run("unassigned", "admin")).rejects.toBeInstanceOf(AccessConflict);
    expect(audit.previous).toHaveBeenCalledWith(expect.any(String), "unassigned");
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "denied", "stale_role");
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
  });
  it("records unchanged roles without claiming a provider write", async () => {
    await run("unassigned");
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "unchanged", "already_assigned", "unassigned");
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
  });
  it("records revocations with both actual old and confirmed new roles", async () => {
    audit.getUser.mockImplementation(async (id: string) => user(id, "admin"));
    await run("unassigned", "admin");
    expect(audit.previous).toHaveBeenCalledWith(expect.any(String), "admin");
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "succeeded", "role_confirmed", "unassigned");
  });
  it("records a provider read failure as not attempted", async () => {
    audit.getUser.mockRejectedValue({ status: 404, token: "not-for-history" });
    await expect(run()).rejects.toBeDefined();
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "failed", "change_not_started");
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
  });
  it.each([new Error("timeout"), { status: 500 }, { status: 404 }])("does not claim failure after a provider write might have taken effect (%j)", async (error) => {
    audit.updateUserMetadata.mockRejectedValue(error);
    await expect(run()).rejects.toBeDefined();
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "unconfirmed", "provider_outcome_unknown");
  });
  it("does not claim success if the provider returned a different role", async () => {
    audit.updateUserMetadata.mockResolvedValue(user("user_target", "unassigned"));
    await expect(run()).rejects.toThrow();
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "unconfirmed", "provider_outcome_unknown");
  });
  it("preserves the unconfirmed intent when final confirmation cannot be stored", async () => {
    audit.finish.mockRejectedValue(new Error("database unavailable"));
    await expect(run()).rejects.toThrow();
    expect(audit.start).toHaveBeenCalledOnce();
    expect(audit.updateUserMetadata).toHaveBeenCalledOnce();
    expect(audit.finish).toHaveBeenCalledOnce();
  });
  it("records a lock failure before any provider update", async () => {
    await expect(auditedRoleChange(store, async () => { throw new Error("lock timeout"); }, directory,
      "user_actor", "user_target", "admin", "unassigned")).rejects.toThrow();
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "failed", "change_not_started");
    expect(audit.getUser).not.toHaveBeenCalled();
  });
  it("rechecks revoked administrators inside the lock and records denial", async () => {
    audit.actorRole = "unassigned";
    await expect(run()).rejects.toBeInstanceOf(AccessConflict);
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "denied", "administrator_required");
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("administrator-only history API", () => {
  it("rejects signed-out history requests and does not create anonymous records", async () => {
    audit.actorId = "";
    expect((await request(app).get("/api/admin/access-history")).status).toBe(401);
    expect(audit.page).not.toHaveBeenCalled();
    expect(audit.start).not.toHaveBeenCalled();
  });
  it("denies ordinary accounts access to records", async () => {
    audit.actorRole = "supervisor";
    const result = await request(app).get("/api/admin/access-history");
    expect(result.status).toBe(403);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(audit.page).not.toHaveBeenCalled();
  });
  it("records non-admin role attempts through the mounted guard without submitted target details", async () => {
    audit.actorRole = "unassigned";
    expect((await request(app).patch("/api/admin/users/user_sensitive/role").send({ role: "admin", token: "private" })).status).toBe(403);
    expect(audit.start).toHaveBeenCalledWith({
      actorId: "user_actor", targetId: null, requestedRole: null, outcome: "denied", reason: "administrator_required",
    });
    expect(audit.updateUserMetadata).not.toHaveBeenCalled();
  });
  it("records restricted actors' attempts before denying identity access", async () => {
    audit.banned = true;
    expect((await request(app).patch("/api/admin/users/user_sensitive/role").send({})).status).toBe(403);
    expect(audit.start).toHaveBeenCalledOnce();
  });
  it("does not fabricate an empty page when the database fails", async () => {
    audit.page.mockRejectedValue(new Error("sensitive connection failure"));
    const result = await request(app).get("/api/admin/access-history");
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain("sensitive");
  });
  it("passes valid cursor strings to the stable page query", async () => {
    const cursor = { beforeTime: "2026-10-27T15:00:00.123Z", beforeId: "c747e2d6-7ca8-4558-8af5-3c59ff419a46" };
    const result = await request(app).get("/api/admin/access-history").query(cursor);
    expect(result.status).toBe(200);
    expect(audit.page).toHaveBeenCalledWith(cursor);
  });
  it.each([{ beforeTime: "invalid" }, { beforeId: "invalid" }, { beforeTime: "2026-10-27T15:00:00.123Z" }])("rejects invalid or incomplete cursors %j", async (cursor) => {
    expect((await request(app).get("/api/admin/access-history").query(cursor)).status).toBe(400);
    expect(audit.page).not.toHaveBeenCalled();
  });
  it("records invalid administrator requests without retaining unvalidated content", async () => {
    const result = await request(app).patch("/api/admin/users/user_target/role").send({ role: "bad", password: "private" });
    expect(result.status).toBe(400);
    expect(audit.start).toHaveBeenCalledWith({
      actorId: "user_actor", targetId: null, requestedRole: null, outcome: "denied", reason: "invalid_request",
    });
  });
  it("returns a role only after durable confirmation", async () => {
    const result = await request(app).patch("/api/admin/users/user_target/role").send({ role: "admin", expectedRole: "unassigned" });
    expect(result.status).toBe(200);
    expect(result.body.role).toBe("admin");
    expect(audit.finish).toHaveBeenCalledWith(expect.any(String), "succeeded", "role_confirmed", "admin");
  });
  it("returns an explicit uncertain response if confirmation storage fails", async () => {
    audit.finish.mockRejectedValue(new Error("connection secret"));
    const result = await request(app).patch("/api/admin/users/user_target/role").send({ role: "admin", expectedRole: "unassigned" });
    expect(result.status).toBe(503);
    expect(result.body.error).toContain("Unable to confirm");
    expect(JSON.stringify(result.body)).not.toContain("secret");
  });
});
