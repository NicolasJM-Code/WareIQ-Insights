import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { reportingChangeNotices } from "../src/lib/reporting-notification-change";
import { notificationMessage, notificationSender } from "../src/lib/access-notification-message";
import { changeRole } from "../src/lib/role-management";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), poolQuery: vi.fn(), release: vi.fn(), send: vi.fn(), getUser: vi.fn(),
  insert: vi.fn(), update: vi.fn(), select: vi.fn(), warn: vi.fn(), summaryQuery: vi.fn(),
  authUserId: null as string | null,
}));
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../lib/db/src/schema")),
  pool: {
    connect: async () => ({ query: mocks.query, release: mocks.release }),
    query: (sql: string, ...params: unknown[]) =>
      sql.includes("count(*) FILTER") ? mocks.summaryQuery(sql, ...params) : mocks.poolQuery(sql, ...params),
  },
  db: { insert: mocks.insert, update: mocks.update, select: mocks.select },
}));
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class { createProxyFetch() { return mocks.send; } },
}));
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: mocks.authUserId }),
  clerkClient: { users: { getUser: mocks.getUser } },
}));
vi.mock("../src/lib/role-lock", () => ({ withRoleLock: async (fn: () => Promise<unknown>) => fn() }));
vi.mock("../src/lib/logger", () => ({ logger: { warn: mocks.warn } }));

import {
  cleanupCompletedAccessNotifications, deliverAccessNotifications, getAccessNotificationSummary, listConfirmedFailedAccessNotifications,
  queueAccessNotifications, retryAllowed, retryConfirmedFailedAccessNotification,
  preparePlatformNotification, confirmPlatformNotification,
} from "../src/lib/access-notifications";
import accessRouter from "../src/routes/access";

const accessApp = express();
accessApp.use("/api", accessRouter);

const member = {
  email: "account@example.test", active: true, roleId: "role-a", clientId: "client-a",
  siteIds: ["site-a", "site-b"], primarySiteId: "site-a",
};

describe("reporting notification changes", () => {
  it("notifies approvals, role changes and disable/delete revocations", () => {
    expect(reportingChangeNotices(undefined, member, "Supervisor")).toEqual([
      { recipient: member.email, roleName: "Supervisor", kind: "reporting" },
    ]);
    expect(reportingChangeNotices(member, { ...member, roleId: "role-b" }, "Manager")[0]?.roleName).toBe("Manager");
    for (const after of [undefined, { ...member, active: false }]) {
      expect(reportingChangeNotices(member, after, "Supervisor")[0]?.roleName).toBe("No reporting access");
    }
  });
  it("does not resend for a retried save, renaming an account, reordered sites or an inactive creation", () => {
    expect(reportingChangeNotices(member, { ...member, siteIds: ["site-b", "site-a"] }, "Supervisor")).toEqual([]);
    expect(reportingChangeNotices(member, member, "Supervisor")).toEqual([]);
    expect(reportingChangeNotices(undefined, { ...member, active: false }, "Supervisor")).toEqual([]);
  });
  it("notifies the old address only of revocation when reassigned to a new email", () => {
    expect(reportingChangeNotices({ ...member, id: "member-1" }, { ...member, id: "member-1", email: "new@example.test" }, "Manager")).toEqual([
      { recipient: member.email, roleName: "No reporting access", kind: "reporting", targetId: "member-1" },
      { recipient: "new@example.test", roleName: "Manager", kind: "reporting", targetId: "member-1" },
    ]);
  });
  it("does not include warehouse assignments, account details or reports in the email", () => {
    const message = notificationMessage("reporting", "Supervisor\nInjected");
    expect(message.text).toContain("New role: Supervisor Injected.");
    expect(message).not.toHaveProperty("html");
    expect(JSON.stringify(message)).not.toContain("site-a");
    expect(notificationSender).toBe("WareIQ <support@chainsoftwaresolutions.com>");
    expect(notificationMessage("platform", "No platform role").text).toContain("Client reporting assignments are managed separately");
  });
});

describe("platform notification confirmation", () => {
  function directory() {
    const account = (id: string, role: string) => ({
      id, firstName: "Test", lastName: "Account", publicMetadata: { role }, privateMetadata: {},
      banned: false, locked: false, primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: `${id}@example.test`, verification: { status: "verified" } }],
    });
    const getUser = vi.fn(async (id: string) => account(id, id === "actor" ? "admin" : "unassigned"));
    const updateUserMetadata = vi.fn(async (_id: string, data: { publicMetadata: { role: string } }) =>
      account("target", data.publicMetadata.role));
    const users = { getUser, updateUserMetadata, getUserList: vi.fn() };
    return { users: users as unknown as Parameters<typeof changeRole>[0], getUser, updateUserMetadata };
  }
  it("stages before Clerk, confirms after success and preserves other metadata via Clerk merge", async () => {
    const d = directory();
    const order: string[] = [];
    const prepare = vi.fn(async () => { order.push("prepare"); return "event-id"; });
    const confirm = vi.fn(async () => { order.push("confirm"); });
    d.updateUserMetadata.mockImplementationOnce(async () => {
      order.push("mutate");
      return { ...(await d.getUser("target")), publicMetadata: { role: "supervisor" } };
    });
    const result = await changeRole(d.users, "actor", "target", "supervisor", "unassigned", undefined, { prepare, confirm });
    expect(order).toEqual(["prepare", "mutate", "confirm"]);
    expect(d.updateUserMetadata).toHaveBeenCalledWith("target", {
      publicMetadata: { role: "supervisor" }, privateMetadata: { wareiqRoleNotificationId: "event-id" },
    });
    expect(result).toMatchObject({ role: "supervisor", notification: "queued" });
  });
  it("does not confirm a failed Clerk write or notify no-op and conflicting retries", async () => {
    const d = directory();
    const hooks = { prepare: vi.fn(async () => "event-id"), confirm: vi.fn() };
    d.updateUserMetadata.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(changeRole(d.users, "actor", "target", "supervisor", "unassigned", undefined, hooks)).rejects.toThrow();
    expect(hooks.confirm).not.toHaveBeenCalled();
    hooks.prepare.mockClear();
    await changeRole(d.users, "actor", "target", "unassigned", "unassigned", undefined, hooks);
    await expect(changeRole(d.users, "actor", "target", "admin", "supervisor", undefined, hooks)).rejects.toThrow();
    expect(hooks.prepare).not.toHaveBeenCalled();
  });
  it("keeps successful role mutation separate from notification errors", async () => {
    const notifications = {
      prepare: vi.fn().mockRejectedValue(new Error("queue down")),
      confirm: vi.fn(),
    };
    const d = directory();
    const result = await changeRole(d.users, "actor", "target", "supervisor", "unassigned", undefined, notifications);
    expect(result).toMatchObject({ role: "supervisor", notification: "failed" });
    expect(d.updateUserMetadata).toHaveBeenCalledOnce();
  });
});

describe("durable delivery and duplicate protection", () => {
  const job = {
    id: "event-one", recipient: member.email, role_name: "Supervisor", kind: "reporting", state: "pending",
    first_attempt_at: null as Date | null, attempts: 0, target_id: null, platform_role: null,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.summaryQuery.mockResolvedValue({ rows: [] });
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT *") ? [{ ...job }] : [] }));
    mocks.send.mockResolvedValue({ ok: true, json: async () => ({ id: "provider-email-id" }) });
    mocks.authUserId = null;
    mocks.getUser.mockReset();
    mocks.select.mockImplementation(() => ({
      from: () => ({ orderBy: async () => [] }),
    }));
  });
  it("exposes only aggregate delivery counts to administrator views", async () => {
    mocks.summaryQuery.mockResolvedValue({ rows: [{
      queued: "2", queued_over_threshold: "1", oldest_queued_age_seconds: "420",
      retrying: "1", accepted: "4", failed: "3",
    }] });
    await expect(getAccessNotificationSummary()).resolves.toEqual({
      queued: 2, queuedOverThreshold: 1, oldestQueuedAgeSeconds: 420,
      queueWarningAfterSeconds: 300, retrying: 1, accepted: 4, failed: 3,
    });
    const statement = mocks.summaryQuery.mock.calls[0][0] as string;
    expect(statement).toContain("count(*) FILTER");
    expect(statement).not.toMatch(/recipient|role_name|provider/i);
    expect(statement).toContain("state IN ('pending', 'confirming') AND attempts = 0");
    expect(mocks.summaryQuery.mock.calls[0][1]).toEqual([300]);
  });
  it("reports no oldest age when no first-attempt notices are queued", async () => {
    mocks.summaryQuery.mockResolvedValue({ rows: [{
      queued: 0, queued_over_threshold: 0, oldest_queued_age_seconds: null,
      retrying: 0, accepted: 0, failed: 0,
    }] });
    await expect(getAccessNotificationSummary()).resolves.toMatchObject({
      queued: 0, queuedOverThreshold: 0, oldestQueuedAgeSeconds: null,
    });
  });
  it("deletes only old terminal notices in a bounded, repeatable batch", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ deleted: "7" }] });
    await expect(cleanupCompletedAccessNotifications()).resolves.toBe(7);

    const [statement, params] = mocks.poolQuery.mock.calls[0]!;
    expect(statement).toContain("state IN ('sent', 'cancelled')");
    expect(statement).toContain("created_at < now()");
    expect(statement).toContain("LIMIT $2");
    expect(statement).toContain("FOR UPDATE SKIP LOCKED");
    expect(statement).toContain("DELETE FROM wareiq_access_notifications");
    expect(params).toEqual([90, 500]);
    expect(statement).not.toMatch(/state\s+IN\s*\([^)]*pending/i);
    expect(statement).not.toMatch(/state\s+IN\s*\([^)]*failed/i);
  });
  it("denies delivery-summary access to signed-out and non-admin users", async () => {
    expect((await request(accessApp).get("/api/access/admin")).status).toBe(401);

    mocks.authUserId = "regular-user";
    mocks.getUser.mockResolvedValue({
      publicMetadata: { role: "supervisor" }, banned: false, locked: false,
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: "user@example.test", verification: { status: "verified" } }],
    });
    expect((await request(accessApp).get("/api/access/admin")).status).toBe(403);

    mocks.authUserId = "unverified-admin";
    mocks.getUser.mockResolvedValue({
      publicMetadata: { role: "admin" }, banned: false, locked: false,
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: "admin@example.test", verification: { status: "unverified" } }],
    });
    expect((await request(accessApp).get("/api/access/admin")).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.summaryQuery).not.toHaveBeenCalled();
  });
  it("returns only aggregate delivery fields to a verified administrator", async () => {
    mocks.authUserId = "admin-user";
    mocks.getUser.mockResolvedValue({
      publicMetadata: { role: "admin" }, banned: false, locked: false,
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: "admin@example.test", verification: { status: "verified" } }],
    });
    mocks.summaryQuery.mockResolvedValue({
      rows: [{
        queued: "2", queued_over_threshold: "1", oldest_queued_age_seconds: "420",
        retrying: "1", accepted: "4", failed: "3",
      }],
    });

    const response = await request(accessApp).get("/api/access/admin");

    expect(response.status).toBe(200);
    expect(response.body.notificationSummary).toEqual({
      status: "available", queued: 2, queuedOverThreshold: 1, oldestQueuedAgeSeconds: 420,
      queueWarningAfterSeconds: 300, retrying: 1, accepted: 4, failed: 3,
    });
    expect(Object.keys(response.body.notificationSummary).sort()).toEqual([
      "accepted", "failed", "oldestQueuedAgeSeconds", "queueWarningAfterSeconds", "queued",
      "queuedOverThreshold", "retrying", "status",
    ]);
    expect(JSON.stringify(response.body.notificationSummary)).not.toMatch(
      /recipient|role.?name|notification.?id|provider|admin@example\.test/i,
    );
  });
  it("commits an attempt before sending and uses a stable provider idempotency key across retries", async () => {
    await deliverAccessNotifications();
    await deliverAccessNotifications();
    for (const [, options] of mocks.send.mock.calls) {
      expect(options.headers["Idempotency-Key"]).toBe("wareiq-access/event-one");
      expect(JSON.parse(options.body).to).toEqual([member.email]);
      expect(JSON.parse(options.body).text).toContain("New role: Supervisor.");
    }
    const queryCalls = mocks.query.mock.calls;
    const attempt = queryCalls.findIndex(([sql]) => sql.includes("first_attempt_at = coalesce"));
    expect(mocks.query.mock.invocationCallOrder[attempt + 1]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
    expect(queryCalls.some(([sql]) => sql.includes("state = 'sent'"))).toBe(true);
  });
  it("retains failed deliveries for retry without marking sent or leaking provider responses", async () => {
    mocks.send.mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: "sensitive provider response" }) });
    await deliverAccessNotifications();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'sent'"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'confirmed_failed'"))).toBe(true);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("sensitive");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("skips a notice cancelled by a newer change after the worker claimed it", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE state IN")) return { rows: [{ ...job, target_id: "member-1" }] };
      if (sql.includes("WHERE id = $1 AND state = 'pending'")) return { rows: [] };
      return { rows: [] };
    });
    await deliverAccessNotifications();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
  });
  it("cancels a pending platform notice when a newer Clerk role is active", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("WHERE state IN")
        ? [{ ...job, kind: "platform", target_id: "target", platform_role: "supervisor" }]
        : [],
    }));
    mocks.getUser.mockResolvedValue({
      privateMetadata: { wareiqRoleNotificationId: "newer-event" },
      publicMetadata: { role: "admin" },
    });
    await deliverAccessNotifications();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'cancelled'"))).toBe(true);
  });
  it("retries uncertain deliveries with the same provider key", async () => {
    mocks.send.mockRejectedValueOnce(new Error("connection interrupted"));
    await deliverAccessNotifications();
    mocks.send.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "provider-email-id" }) });
    await deliverAccessNotifications();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.send.mock.calls) {
      expect(options.headers["Idempotency-Key"]).toBe("wareiq-access/event-one");
    }
  });
  it("never sends an unconfirmed Clerk event and recovers a confirmed write after a crash", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("SELECT *") ? [{ ...job, state: "confirming", target_id: "target", platform_role: "supervisor" }] : [],
    }));
    mocks.getUser.mockResolvedValue({ privateMetadata: {}, publicMetadata: { role: "unassigned" } });
    await deliverAccessNotifications();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'cancelled'"))).toBe(true);
    mocks.getUser.mockResolvedValue({ privateMetadata: { wareiqRoleNotificationId: job.id }, publicMetadata: { role: "supervisor" } });
    await deliverAccessNotifications();
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it("fails closed outside the provider deduplication window", async () => {
    const now = new Date();
    expect(retryAllowed(null, now)).toBe(true);
    expect(retryAllowed(new Date(now.getTime() - 23 * 3600_000), now)).toBe(false);
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("SELECT *") ? [{ ...job, first_attempt_at: new Date(now.getTime() - 24 * 3600_000) }] : [],
    }));
    await deliverAccessNotifications();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'failed'"))).toBe(true);
  });
  it.each([408, 503])("does not mark status %i as a confirmed failure", async (status) => {
    mocks.send.mockResolvedValue({ ok: false, status, json: async () => ({}) });
    await deliverAccessNotifications();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'confirmed_failed'"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'sent'"))).toBe(false);
  });
  it("keeps a success response without a provider ID ambiguous", async () => {
    mocks.send.mockResolvedValue({ ok: true, json: async () => ({}) });
    await deliverAccessNotifications();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'confirmed_failed'"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("state = 'sent'"))).toBe(false);
  });
  it("reuses the original provider idempotency key after retrying a confirmed rejection", async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) });
    await deliverAccessNotifications();
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: job.id }] });
    await expect(retryConfirmedFailedAccessNotification(job.id)).resolves.toBe(true);

    mocks.send.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "provider-email-id" }) });
    await deliverAccessNotifications();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls.map(([, options]) => options.headers["Idempotency-Key"]))
      .toEqual([`wareiq-access/${job.id}`, `wareiq-access/${job.id}`]);
  });
  it("lists only confirmed provider rejections and retries atomically without changing notice identity", async () => {
    const failedNotice = {
      id: "event-one", recipient: member.email, role_name: "Supervisor",
      kind: "reporting", created_at: new Date(), attempts: 2,
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [failedNotice] });
    await expect(listConfirmedFailedAccessNotifications()).resolves.toEqual([failedNotice]);
    expect(mocks.poolQuery.mock.calls[0]![0]).toContain("state = 'confirmed_failed'");

    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: "event-one" }] });
    await expect(retryConfirmedFailedAccessNotification("event-one")).resolves.toBe(true);
    const [sql, params] = mocks.poolQuery.mock.calls[1]!;
    expect(sql).toContain("state = 'confirmed_failed'");
    expect(sql).toContain("first_attempt_at = NULL");
    expect(sql).toContain("RETURNING id");
    expect(params).toEqual(["event-one"]);

    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(retryConfirmedFailedAccessNotification("event-one")).resolves.toBe(false);
  });
  it("isolates outbox insertion failure inside a savepoint", async () => {
    const transaction = vi.fn(async () => { throw new Error("insert failed"); });
    const result = await queueAccessNotifications(
      { transaction } as unknown as Parameters<typeof queueAccessNotifications>[0],
      [{ recipient: member.email, roleName: "Supervisor", kind: "reporting" }],
    );
    expect(result).toBe("failed");
    expect(transaction).toHaveBeenCalledOnce();
    expect(await queueAccessNotifications({} as never, [])).toBe("not_needed");
  });
  it("cancels older unsent notices before inserting the latest access state", async () => {
    const operations: string[] = [];
    const tx = {
      transaction: async (callback: (savepoint: unknown) => Promise<void>) => callback({
        update: () => ({ set: () => ({ where: async () => { operations.push("cancel"); } }) }),
        insert: () => ({ values: async () => { operations.push("insert"); } }),
      }),
    };
    const result = await queueAccessNotifications(
      tx as unknown as Parameters<typeof queueAccessNotifications>[0],
      [{ recipient: member.email, roleName: "Manager", kind: "reporting", targetId: "member-1" }],
    );
    expect(result).toBe("queued");
    expect(operations).toEqual(["cancel", "insert"]);
  });
  it("does not let staging or confirmation errors escape to the role route", async () => {
    mocks.insert.mockReturnValue({ values: vi.fn().mockRejectedValue(new Error("database unavailable")) });
    mocks.update.mockReturnValue({ set: () => ({ where: vi.fn().mockRejectedValue(new Error("database unavailable")) }) });
    expect(await preparePlatformNotification({
      recipient: member.email, kind: "platform", roleName: "Administrator",
    }, "target", "admin")).toBeNull();
    await expect(confirmPlatformNotification("event-id")).resolves.toBeUndefined();
  });
});
