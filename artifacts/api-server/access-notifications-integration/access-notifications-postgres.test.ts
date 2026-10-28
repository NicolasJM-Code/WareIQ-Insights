import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  db,
  pool,
  socketDirectory,
  startDatabase,
  stopDatabase,
} from "./database";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: (await import("./database")).db,
  pool: (await import("./database")).pool,
}));
vi.mock("../../../lib/db/src/index", async () => ({
  ...await import("@workspace/db/schema"),
  db: (await import("./database")).db,
  pool: (await import("./database")).pool,
}));
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class { createProxyFetch() { return mocks.send; } },
}));
vi.mock("@clerk/express", () => ({ clerkClient: { users: { getUser: vi.fn() } } }));
vi.mock("../src/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { clerkClient } from "@clerk/express";
import {
  cleanupCompletedAccessNotifications,
  confirmPlatformNotification,
  deliverAccessNotifications,
  getAccessNotificationSummary,
  listConfirmedFailedAccessNotifications,
  listUncertainAccessNotifications,
  preparePlatformNotification,
  queueAccessNotifications,
} from "../src/lib/access-notifications";
import { withRoleLock } from "../src/lib/role-lock";
import { changeRole } from "../src/lib/role-management";

const oldNotice = {
  id: "older-notice",
  recipient: "member@example.test",
  roleName: "Supervisor",
  kind: "reporting" as const,
  targetId: "member-1",
};
const newNotice = {
  recipient: "member@example.test",
  roleName: "Manager",
  kind: "reporting" as const,
  targetId: "member-1",
};

async function waitForActivity(predicate: (activity: { query: string; wait_event_type: string | null; wait_event: string | null }) => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{
      query: string;
      wait_event_type: string | null;
      wait_event: string | null;
    }>(`SELECT query, wait_event_type, wait_event
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'`);
    if (rows.some(predicate)) return;
    await delay(10);
  }
  const { rows } = await pool.query(
    `SELECT state, wait_event_type, wait_event, query
     FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  throw new Error(`Timed out waiting for the expected PostgreSQL lock: ${JSON.stringify(rows)}`);
}

async function waitForCleanupWaiters(count: number) {
  await expect.poll(async () => {
    const { rows } = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query ILIKE '%WITH expired AS%'
    `);
    return rows[0]?.count ?? 0;
  }, { timeout: 5_000, interval: 10 }).toBe(count);
}

async function waitForSendCount(count: number) {
  await expect.poll(() => mocks.send.mock.calls.length, { timeout: 5_000, interval: 10 }).toBe(count);
}

async function queueLatestNotice() {
  return db.transaction((tx) => queueAccessNotifications(tx, [newNotice]));
}

function makeUser(id: string, email: string, role: string, eventId?: string) {
  return {
    id,
    firstName: "Test",
    lastName: "Member",
    primaryEmailAddressId: "primary",
    emailAddresses: [{
      id: "primary",
      emailAddress: email,
      verification: { status: "verified" },
    }],
    publicMetadata: { role },
    privateMetadata: eventId ? { wareiqRoleNotificationId: eventId } : {},
    banned: false,
    locked: false,
  } as unknown as Awaited<ReturnType<typeof clerkClient.users.getUser>>;
}

async function insertPlatformNotice(id: string, role: string) {
  await pool.query(`
    INSERT INTO wareiq_access_notifications
      (id, recipient, role_name, kind, state, target_id, platform_role, attempts, next_attempt_at)
    VALUES ($1, 'member@example.test', 'Legacy Supervisor', 'platform', 'pending',
            'member-1', $2, 0, now())
  `, [id, role]);
  await pool.query(
    "UPDATE wareiq_access_notifications SET created_at = now() - interval '1 minute' WHERE id = $1",
    [id],
  );
}

async function waitForRoleLockWaiter() {
  await expect.poll(async () => {
    const { rows } = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query ILIKE '%pg_advisory_xact_lock(174983, 1)%'
    `);
    return rows[0]?.count ?? 0;
  }, { timeout: 5_000, interval: 10 }).toBe(1);
}

async function changeMemberRole(
  target: Awaited<ReturnType<typeof clerkClient.users.getUser>>,
  updateTarget: (user: Awaited<ReturnType<typeof clerkClient.users.getUser>>) => void,
) {
  const actor = makeUser("admin-1", "admin@example.test", "admin");
  const users = {
    getUser: vi.fn(async (id: string) => id === actor.id ? actor : target),
    updateUserMetadata: vi.fn(async (
      _id: string,
      metadata: { publicMetadata?: Record<string, unknown>; privateMetadata?: Record<string, unknown> },
    ) => {
      const updated = {
        ...target,
        publicMetadata: { ...target.publicMetadata, ...metadata.publicMetadata },
        privateMetadata: { ...target.privateMetadata, ...metadata.privateMetadata },
      } as typeof target;
      updateTarget(updated);
      return updated;
    }),
  } as unknown as Parameters<typeof changeRole>[0];
  const notifications = {
    prepare: (recipient: string, targetId: string, role: "admin" | "supervisor" | "unassigned") =>
      preparePlatformNotification({
        recipient,
        kind: "platform",
        roleName: role === "admin" ? "Administrator" : role === "supervisor" ? "Legacy Supervisor" : "No platform role",
      }, targetId, role),
    confirm: confirmPlatformNotification,
  };
  return changeRole(users, actor.id, target.id, "admin", "supervisor", undefined, notifications);
}

describe("access notification transaction ordering in private PostgreSQL", () => {
  beforeAll(startDatabase);
  afterAll(stopDatabase);
  beforeEach(async () => {
    mocks.send.mockReset();
    await pool.query("DROP TRIGGER IF EXISTS notification_claim_barrier ON wareiq_access_notifications");
    await pool.query("DROP FUNCTION IF EXISTS notification_claim_barrier()");
    await pool.query("DROP TRIGGER IF EXISTS notification_cleanup_barrier ON wareiq_access_notifications");
    await pool.query("DROP FUNCTION IF EXISTS notification_cleanup_barrier()");
    await pool.query("DROP TRIGGER IF EXISTS notification_status_barrier ON wareiq_access_notifications");
    await pool.query("DROP FUNCTION IF EXISTS notification_status_barrier()");
    await pool.query("TRUNCATE wareiq_access_notifications");
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, target_id, attempts, next_attempt_at)
      VALUES ($1, $2, $3, 'reporting', 'pending', $4, 0, now())
    `, [oldNotice.id, oldNotice.recipient, oldNotice.roleName, oldNotice.targetId]);
  });

  it("seeks confirmed-failure cursor pages with a state-specific creation-order index", async () => {
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, created_at)
      SELECT 'page-index-' || series,
             'member@example.test',
             'Supervisor',
             'reporting',
             CASE WHEN series % 100 = 0 THEN 'confirmed_failed' ELSE 'pending' END,
             now() - series * interval '1 second'
      FROM generate_series(1, 10000) AS series
    `);
    await pool.query("ANALYZE wareiq_access_notifications");

    const index = await pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'wareiq_access_notifications'
        AND indexname = 'wareiq_access_notifications_confirmed_failed_page'
    `);
    expect(index.rows[0]?.indexdef).toContain(
      "USING btree (created_at, id) WHERE (state = 'confirmed_failed'::text)",
    );

    type QueryPlanNode = {
      "Node Type": string;
      "Index Name"?: string;
      Plans?: QueryPlanNode[];
    };
    const explain = await pool.query<{
      "QUERY PLAN": Array<{ Plan: QueryPlanNode }>;
    }>(`
      EXPLAIN (FORMAT JSON)
      SELECT id, created_at
      FROM wareiq_access_notifications
      WHERE state = 'confirmed_failed'
        AND (created_at, id) < (now() - interval '50 minutes', 'page-index-5000')
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `);
    const plan = explain.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
    const findPageIndex = (node: QueryPlanNode | undefined): QueryPlanNode | undefined => {
      if (node?.["Index Name"] === "wareiq_access_notifications_confirmed_failed_page") return node;
      return node?.Plans?.map(findPageIndex).find(Boolean);
    };
    expect(findPageIndex(plan)?.["Node Type"]).toMatch(/^Index (Only )?Scan$/);
  });

  it("skips a claimed notice when a newer access change cancels it first", async () => {
    expect(pool.options.host).toBe(socketDirectory);
    const settings = await pool.query<{ listen_addresses: string }>("SHOW listen_addresses");
    expect(settings.rows[0]?.listen_addresses).toBe("");

    await pool.query(`
      CREATE FUNCTION notification_claim_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.attempts > OLD.attempts THEN
          PERFORM pg_advisory_xact_lock(271828, 182845);
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER notification_claim_barrier
      BEFORE UPDATE ON wareiq_access_notifications
      FOR EACH ROW EXECUTE FUNCTION notification_claim_barrier()
    `);

    const blocker = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(271828, 182845)");
    const delivery = deliverAccessNotifications();
    let queued: Promise<unknown> | undefined;
    try {
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock" && activity.wait_event === "advisory"
          && activity.query.includes("first_attempt_at = coalesce"));

      queued = queueLatestNotice();
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock" && activity.query.toLowerCase().includes("update \"wareiq_access_notifications\"")
          && !activity.query.includes("first_attempt_at = coalesce"));

      await blocker.query("SELECT pg_advisory_unlock(271828, 182845)");
      await Promise.all([delivery, queued]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(271828, 182845)").catch(() => undefined);
      blocker.release();
      if (queued) await queued.catch(() => undefined);
      await delivery.catch(() => undefined);
    }

    expect(mocks.send).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      "SELECT id, role_name, state FROM wareiq_access_notifications",
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ id: "older-notice", role_name: "Supervisor", state: "cancelled" });
    expect(rows).toContainEqual(expect.objectContaining({ role_name: "Manager", state: "pending" }));
  });

  it("finishes delivery under its row lock before the newer access change", async () => {
    let resolveSend!: (response: { ok: true; json: () => Promise<{ id: string }> }) => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    mocks.send.mockImplementation(() => {
      markSendStarted();
      return new Promise((resolve) => { resolveSend = resolve; });
    });
    const delivery = deliverAccessNotifications();
    await sendStarted;
    let queuedFinished = false;
    let queuedStatus: unknown;
    const queued = queueLatestNotice().then((status) => {
      queuedFinished = true;
      queuedStatus = status;
    });

    try {
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock" && activity.query.toLowerCase().includes("update \"wareiq_access_notifications\"")
          && !activity.query.includes("first_attempt_at = coalesce"));
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(queuedFinished).toBe(false);

      resolveSend({ ok: true, json: async () => ({ id: "provider-id" }) });
      await Promise.all([delivery, queued]);
    } finally {
      resolveSend?.({ ok: true, json: async () => ({ id: "provider-id" }) });
      await Promise.all([delivery.catch(() => undefined), queued.catch(() => undefined)]);
    }

    expect(queuedStatus).toBe("queued");
    const { rows } = await pool.query(
      "SELECT id, role_name, state FROM wareiq_access_notifications",
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ id: "older-notice", role_name: "Supervisor", state: "sent" });
    expect(rows).toContainEqual(expect.objectContaining({ role_name: "Manager", state: "pending" }));
  });

  it("lets a role change cancel a stale platform email without deadlocking", async () => {
    const oldEventId = "platform-old-event";
    await insertPlatformNotice(oldEventId, "supervisor");
    let target = makeUser("member-1", "member@example.test", "supervisor", oldEventId);
    vi.mocked(clerkClient.users.getUser).mockImplementation(async (id) =>
      id === "member-1" ? target : makeUser(id, "admin@example.test", "admin"),
    );

    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve; });
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = withRoleLock(async () => {
      markMutationStarted();
      await mutationGate;
      return changeMemberRole(target, (updated) => { target = updated; });
    });
    await mutationStarted;

    const delivery = deliverAccessNotifications();
    try {
      await waitForRoleLockWaiter();
      releaseMutation();
      await Promise.all([mutation, delivery]);
    } finally {
      releaseMutation();
      await Promise.all([mutation.catch(() => undefined), delivery.catch(() => undefined)]);
    }

    expect(target.publicMetadata.role).toBe("admin");
    expect(target.privateMetadata.wareiqRoleNotificationId).not.toBe(oldEventId);
    expect(mocks.send).not.toHaveBeenCalled();
    const { rows } = await pool.query<{ id: string; state: string; platform_role: string | null }>(`
      SELECT id, state, platform_role FROM wareiq_access_notifications
      WHERE kind = 'platform' ORDER BY created_at, id
    `);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: oldEventId, state: "cancelled", platform_role: "supervisor" });
    expect(rows[1]).toMatchObject({ state: "pending", platform_role: "admin" });
  });

  it("sends a platform email under the role lock before a waiting role change", async () => {
    const eventId = "platform-current-event";
    await insertPlatformNotice(eventId, "supervisor");
    let target = makeUser("member-1", "member@example.test", "supervisor", eventId);
    vi.mocked(clerkClient.users.getUser).mockImplementation(async (id) =>
      id === "member-1" ? target : makeUser(id, "admin@example.test", "admin"),
    );

    let resolveSend!: (response: { ok: true; json: () => Promise<{ id: string }> }) => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    mocks.send.mockImplementation(() => {
      markSendStarted();
      return new Promise((resolve) => { resolveSend = resolve; });
    });

    const delivery = deliverAccessNotifications();
    await sendStarted;
    const mutation = withRoleLock(() =>
      changeMemberRole(target, (updated) => { target = updated; }),
    );
    try {
      await waitForRoleLockWaiter();
      resolveSend({ ok: true, json: async () => ({ id: "provider-id" }) });
      await Promise.all([delivery, mutation]);
    } finally {
      resolveSend?.({ ok: true, json: async () => ({ id: "provider-id" }) });
      await Promise.all([delivery.catch(() => undefined), mutation.catch(() => undefined)]);
    }

    expect(mocks.send).toHaveBeenCalledOnce();
    const { rows } = await pool.query<{ id: string; state: string; platform_role: string | null }>(`
      SELECT id, state, platform_role FROM wareiq_access_notifications
      WHERE kind = 'platform' ORDER BY created_at, id
    `);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: eventId, state: "sent", platform_role: "supervisor" });
    expect(rows[1]).toMatchObject({ state: "pending", platform_role: "admin" });
  });

  it("lets concurrent workers skip a locked notice and send each eligible notice once", async () => {
    expect(pool.options.host).toBe(socketDirectory);
    await pool.query(
      "UPDATE wareiq_access_notifications SET created_at = now() - interval '1 second' WHERE id = $1",
      [oldNotice.id],
    );
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, target_id, attempts, next_attempt_at)
      VALUES ('second-notice', 'second@example.test', 'Manager', 'reporting', 'pending', 'member-2', 0, now())
    `);
    await pool.query(`
      CREATE FUNCTION notification_claim_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = 'older-notice' AND NEW.attempts > OLD.attempts THEN
          PERFORM pg_advisory_xact_lock(271828, 182845);
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER notification_claim_barrier
      BEFORE UPDATE ON wareiq_access_notifications
      FOR EACH ROW EXECUTE FUNCTION notification_claim_barrier()
    `);

    type ProviderResponse = { ok: true; json: () => Promise<{ id: string }> };
    const idempotencyKeys: string[] = [];
    const pendingResponses: Array<(response: ProviderResponse) => void> = [];
    let autoResolveResponses = false;
    const confirmedResponse = (): ProviderResponse => ({
      ok: true,
      json: async () => ({ id: "provider-id" }),
    });
    const releaseProviderResponses = () => {
      autoResolveResponses = true;
      for (const resolve of pendingResponses.splice(0)) resolve(confirmedResponse());
    };
    mocks.send.mockImplementation((_url: string, init: { headers: Record<string, string> }) => {
      idempotencyKeys.push(init.headers["Idempotency-Key"]!);
      return new Promise<ProviderResponse>((resolve) => {
        if (autoResolveResponses) resolve(confirmedResponse());
        else pendingResponses.push(resolve);
      });
    });

    const blocker = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(271828, 182845)");
    const firstWorker = deliverAccessNotifications();
    let secondWorker: Promise<void> | undefined;
    try {
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock"
          && activity.wait_event === "advisory"
          && activity.query.includes("first_attempt_at = coalesce"));

      secondWorker = deliverAccessNotifications();
      await waitForSendCount(1);
      expect(idempotencyKeys).toEqual(["wareiq-access/second-notice"]);

      await blocker.query("SELECT pg_advisory_unlock(271828, 182845)");
      await waitForSendCount(2);
      expect(idempotencyKeys).toEqual([
        "wareiq-access/second-notice",
        "wareiq-access/older-notice",
      ]);
      releaseProviderResponses();
      await Promise.all([firstWorker, secondWorker]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(271828, 182845)").catch(() => undefined);
      releaseProviderResponses();
      blocker.release();
      await Promise.all([
        firstWorker.catch(() => undefined),
        ...(secondWorker ? [secondWorker.catch(() => undefined)] : []),
      ]);
    }

    const { rows } = await pool.query<{ id: string; state: string; attempts: number }>(
      "SELECT id, state, attempts FROM wareiq_access_notifications ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "older-notice", state: "sent", attempts: 1 },
      { id: "second-notice", state: "sent", attempts: 1 },
    ]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(idempotencyKeys).toEqual([
      "wareiq-access/second-notice",
      "wareiq-access/older-notice",
    ]);
  });

  it.each([
    { state: "confirmed_failed", count: "failed", list: "confirmed" },
    { state: "failed", count: "uncertain", list: "uncertain" },
  ] as const)("keeps the $count count and visible $list list aligned across a state commit", async ({ state, count, list }) => {
    await pool.query(`
      UPDATE wareiq_access_notifications SET attempts = 1 WHERE id = $1
    `, [oldNotice.id]);
    await pool.query(`
      CREATE FUNCTION notification_status_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state IN ('confirmed_failed', 'failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
          PERFORM pg_advisory_xact_lock(1618033, 1414213);
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER notification_status_barrier
      BEFORE UPDATE OF state ON wareiq_access_notifications
      FOR EACH ROW EXECUTE FUNCTION notification_status_barrier()
    `);

    const blocker = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(1618033, 1414213)");
    const transition = pool.query(
      "UPDATE wareiq_access_notifications SET state = $1 WHERE id = $2",
      [state, oldNotice.id],
    );
    try {
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock"
          && activity.wait_event === "advisory"
          && activity.query.toLowerCase().includes("update wareiq_access_notifications"),
      );

      // While the transition is uncommitted, each read must observe the prior
      // committed state; no reader can see a count/list split for this notice.
      const [duringSummary, duringConfirmed, duringUncertain] = await Promise.all([
        getAccessNotificationSummary(),
        listConfirmedFailedAccessNotifications(),
        listUncertainAccessNotifications(),
      ]);
      expect(duringSummary[count]).toBe(0);
      expect(duringConfirmed.rows).toEqual([]);
      expect(duringUncertain).toEqual([]);

      await blocker.query("SELECT pg_advisory_unlock(1618033, 1414213)");
      await transition;

      const [afterSummary, afterConfirmed, afterUncertain] = await Promise.all([
        getAccessNotificationSummary(),
        listConfirmedFailedAccessNotifications(),
        listUncertainAccessNotifications(),
      ]);
      expect(afterSummary[count]).toBe(1);
      if (list === "confirmed") {
        expect(afterConfirmed.rows.map((notice) => notice.id)).toEqual([oldNotice.id]);
        expect(afterUncertain).toEqual([]);
      } else {
        expect(afterConfirmed.rows).toEqual([]);
        expect(afterUncertain.map((notice) => notice.id)).toEqual([oldNotice.id]);
      }
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(1618033, 1414213)").catch(() => undefined);
      blocker.release();
      await transition.catch(() => undefined);
    }
  });

  it("catches up in bounded overlapping batches while preserving pending and failed notices", async () => {
    expect(pool.options.host).toBe(socketDirectory);
    await pool.query(`
      UPDATE wareiq_access_notifications
      SET created_at = now() - interval '91 days'
      WHERE id = $1
    `, [oldNotice.id]);
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, created_at)
      VALUES ('expired-failed', 'failed@example.test', 'Supervisor', 'reporting', 'failed',
              now() - interval '91 days')
    `);
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, created_at)
      SELECT 'expired-eligible-' || series,
             'eligible@example.test',
             'Supervisor',
             'reporting',
             CASE WHEN series % 2 = 0 THEN 'sent' ELSE 'cancelled' END,
             now() - interval '91 days'
      FROM generate_series(1, 2501) AS series
    `);

    await pool.query(`
      CREATE FUNCTION notification_cleanup_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(314159, 265358);
        RETURN OLD;
      END
      $$;
      CREATE TRIGGER notification_cleanup_barrier
      BEFORE DELETE ON wareiq_access_notifications
      FOR EACH ROW EXECUTE FUNCTION notification_cleanup_barrier()
    `);

    const blocker = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(314159, 265358)");
    let first: Promise<number> | undefined;
    let second: Promise<number> | undefined;
    try {
      first = cleanupCompletedAccessNotifications();
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock"
          && activity.wait_event === "advisory"
          && activity.query.includes("WITH expired AS"));

      second = cleanupCompletedAccessNotifications();
      await waitForCleanupWaiters(2);

      await blocker.query("SELECT pg_advisory_unlock(314159, 265358)");
      const deletedCounts = await Promise.all([first, second]);
      expect(deletedCounts.reduce((sum, count) => sum + count, 0)).toBe(2501);
      expect(deletedCounts.some((count) => count > 500)).toBe(true);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(314159, 265358)").catch(() => undefined);
      blocker.release();
      await Promise.all([first, second].filter(Boolean).map((run) => run!.catch(() => 0)));
    }

    expect(await cleanupCompletedAccessNotifications()).toBe(0);

    const { rows } = await pool.query<{ id: string; state: string }>(`
      SELECT id, state FROM wareiq_access_notifications ORDER BY id
    `);
    expect(rows).toEqual([
      { id: "expired-failed", state: "failed" },
      { id: oldNotice.id, state: "pending" },
    ]);
  });

  it("keeps sent and cancelled notices inside the 90-day retention window", async () => {
    expect(pool.options.host).toBe(socketDirectory);
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, created_at)
      VALUES
        ('sent-inside-retention', 'member@example.test', 'Supervisor', 'reporting', 'sent',
         now() - interval '90 days' + interval '1 minute'),
        ('cancelled-inside-retention', 'member@example.test', 'Supervisor', 'reporting', 'cancelled',
         now() - interval '90 days' + interval '1 minute'),
        ('sent-outside-retention', 'member@example.test', 'Supervisor', 'reporting', 'sent',
         now() - interval '90 days' - interval '1 minute'),
        ('cancelled-outside-retention', 'member@example.test', 'Supervisor', 'reporting', 'cancelled',
         now() - interval '90 days' - interval '1 minute')
    `);

    expect(await cleanupCompletedAccessNotifications()).toBe(2);

    const { rows } = await pool.query<{ id: string; state: string }>(`
      SELECT id, state FROM wareiq_access_notifications ORDER BY id
    `);
    expect(rows).toEqual([
      { id: "cancelled-inside-retention", state: "cancelled" },
      { id: oldNotice.id, state: "pending" },
      { id: "sent-inside-retention", state: "sent" },
    ]);
  });

  it("delivers a pending notice while cleanup is deleting expired history", async () => {
    expect(pool.options.host).toBe(socketDirectory);
    await pool.query(`
      UPDATE wareiq_access_notifications
      SET state = 'sent', created_at = now() - interval '91 days'
      WHERE id = $1
    `, [oldNotice.id]);
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, target_id, attempts, next_attempt_at)
      VALUES ('delivery-during-cleanup', 'member@example.test', 'Manager',
              'reporting', 'pending', 'member-1', 0, now())
    `);
    await pool.query(`
      CREATE FUNCTION notification_cleanup_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(314159, 265358);
        RETURN OLD;
      END
      $$;
      CREATE TRIGGER notification_cleanup_barrier
      BEFORE DELETE ON wareiq_access_notifications
      FOR EACH ROW EXECUTE FUNCTION notification_cleanup_barrier()
    `);
    mocks.send.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "provider-id" }),
    });

    const blocker = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(314159, 265358)");
    let cleanup: Promise<number> | undefined;
    let delivery: Promise<void> | undefined;
    try {
      cleanup = cleanupCompletedAccessNotifications();
      await waitForActivity((activity) =>
        activity.wait_event_type === "Lock"
          && activity.wait_event === "advisory"
          && activity.query.includes("WITH expired AS"));

      delivery = deliverAccessNotifications();
      await delivery;

      const duringCleanup = await pool.query<{ id: string; state: string }>(`
        SELECT id, state FROM wareiq_access_notifications
        WHERE id IN ($1, 'delivery-during-cleanup')
        ORDER BY id
      `, [oldNotice.id]);
      expect(duringCleanup.rows).toEqual([
        { id: "delivery-during-cleanup", state: "sent" },
        { id: oldNotice.id, state: "sent" },
      ]);
      expect(mocks.send).toHaveBeenCalledOnce();

      await blocker.query("SELECT pg_advisory_unlock(314159, 265358)");
      expect(await cleanup).toBe(1);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(314159, 265358)").catch(() => undefined);
      blocker.release();
      await Promise.all([
        cleanup?.catch(() => 0),
        delivery?.catch(() => undefined),
      ]);
    }

    const { rows } = await pool.query<{ id: string; state: string }>(
      "SELECT id, state FROM wareiq_access_notifications ORDER BY id",
    );
    expect(rows).toEqual([{ id: "delivery-during-cleanup", state: "sent" }]);
  });

  it("keeps failed-notice pages stable when a newer confirmed failure arrives", async () => {
    expect(pool.options.host).toBe(socketDirectory);
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, attempts, created_at)
      SELECT 'old-failure-' || lpad(series::text, 3, '0'),
             'member@example.test',
             'Supervisor',
             'reporting',
             'confirmed_failed',
             2,
             TIMESTAMPTZ '2026-10-28 12:00:00.123456+00'
               + (series / 7) * INTERVAL '1 microsecond'
      FROM generate_series(0, 204) AS series
    `);

    const expectedOlderIds = Array.from({ length: 205 }, (_, index) =>
      `old-failure-${String(index).padStart(3, "0")}`,
    ).reverse();
    const firstPage = await listConfirmedFailedAccessNotifications();
    expect(firstPage.rows.map((notice) => notice.id)).toEqual(expectedOlderIds.slice(0, 100));
    expect(firstPage.nextCursor).not.toBeNull();

    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, attempts, created_at)
      VALUES (
        'newer-failure',
        'member@example.test',
        'Supervisor',
        'reporting',
        'confirmed_failed',
        2,
        TIMESTAMPTZ '2026-10-28 12:01:00.000001+00'
      )
    `);

    const walkedIds = [...firstPage.rows.map((notice) => notice.id)];
    let cursor = firstPage.nextCursor;
    while (cursor) {
      const page = await listConfirmedFailedAccessNotifications(cursor);
      walkedIds.push(...page.rows.map((notice) => notice.id));
      cursor = page.nextCursor;
    }

    expect(walkedIds).toEqual(expectedOlderIds);
    expect(new Set(walkedIds).size).toBe(expectedOlderIds.length);
    const refreshedFirstPage = await listConfirmedFailedAccessNotifications();
    expect(refreshedFirstPage.rows[0]?.id).toBe("newer-failure");
  });
});
