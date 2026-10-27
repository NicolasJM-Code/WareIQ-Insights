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
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class { createProxyFetch() { return mocks.send; } },
}));
vi.mock("@clerk/express", () => ({ clerkClient: { users: { getUser: vi.fn() } } }));
vi.mock("../src/lib/role-lock", () => ({ withRoleLock: async (run: () => Promise<unknown>) => run() }));
vi.mock("../src/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  deliverAccessNotifications,
  queueAccessNotifications,
} from "../src/lib/access-notifications";

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

async function queueLatestNotice() {
  return db.transaction((tx) => queueAccessNotifications(tx, [newNotice]));
}

describe("access notification transaction ordering in private PostgreSQL", () => {
  beforeAll(startDatabase);
  afterAll(stopDatabase);
  beforeEach(async () => {
    mocks.send.mockReset();
    await pool.query("DROP TRIGGER IF EXISTS notification_claim_barrier ON wareiq_access_notifications");
    await pool.query("DROP FUNCTION IF EXISTS notification_claim_barrier()");
    await pool.query("TRUNCATE wareiq_access_notifications");
    await pool.query(`
      INSERT INTO wareiq_access_notifications
        (id, recipient, role_name, kind, state, target_id, attempts, next_attempt_at)
      VALUES ($1, $2, $3, 'reporting', 'pending', $4, 0, now())
    `, [oldNotice.id, oldNotice.recipient, oldNotice.roleName, oldNotice.targetId]);
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
});
