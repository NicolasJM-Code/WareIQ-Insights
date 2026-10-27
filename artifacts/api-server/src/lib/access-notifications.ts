import { randomUUID } from "node:crypto";
import { db, pool, accessNotificationsTable } from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { clerkClient } from "@clerk/express";
import { logger } from "./logger";
import { withRoleLock } from "./role-lock";
import { notificationMessage, notificationSender } from "./access-notification-message";
import type { AppRole } from "./access-policy";

export type NotificationStatus = "queued" | "failed" | "not_needed";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Notice = {
  recipient: string; roleName: string; kind: "reporting" | "platform"; targetId?: string;
};
export type AccessNotificationSummary = {
  queued: number;
  retrying: number;
  accepted: number;
  failed: number;
};

// Keep completed outbox history for 90 days. Each run removes at most 500 rows.
const COMPLETED_NOTIFICATION_RETENTION_DAYS = 90;
const COMPLETED_NOTIFICATION_CLEANUP_BATCH_SIZE = 500;
const COMPLETED_NOTIFICATION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function getAccessNotificationSummary(): Promise<AccessNotificationSummary> {
  const { rows } = await pool.query<{
    queued: number | string;
    retrying: number | string;
    accepted: number | string;
    failed: number | string;
  }>(`SELECT
      count(*) FILTER (WHERE state IN ('pending', 'confirming') AND attempts = 0)::int AS queued,
      count(*) FILTER (WHERE state = 'pending' AND attempts > 0)::int AS retrying,
      count(*) FILTER (WHERE state = 'sent')::int AS accepted,
      count(*) FILTER (WHERE state IN ('failed', 'confirmed_failed'))::int AS failed
    FROM wareiq_access_notifications`);
  const summary = rows[0];
  if (!summary) throw new Error("Notification summary unavailable");
  return {
    queued: Number(summary.queued),
    retrying: Number(summary.retrying),
    accepted: Number(summary.accepted),
    failed: Number(summary.failed),
  };
}

export async function cleanupCompletedAccessNotifications(): Promise<number> {
  const { rows } = await pool.query<{ deleted: number | string }>(`
    WITH expired AS (
      SELECT id
      FROM wareiq_access_notifications
      WHERE state IN ('sent', 'cancelled')
        AND created_at < now() - ($1 * interval '1 day')
      ORDER BY created_at
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    ),
    deleted AS (
      DELETE FROM wareiq_access_notifications
      WHERE id IN (SELECT id FROM expired)
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `, [COMPLETED_NOTIFICATION_RETENTION_DAYS, COMPLETED_NOTIFICATION_CLEANUP_BATCH_SIZE]);
  const result = rows[0];
  if (!result) throw new Error("Notification cleanup unavailable");
  return Number(result.deleted);
}

// A savepoint isolates queue failures from the access change's transaction.
export async function queueAccessNotifications(tx: Transaction, notices: Notice[]): Promise<NotificationStatus> {
  if (!notices.length) return "not_needed";
  try {
    await tx.transaction(async (savepoint) => {
      const targetIds = [...new Set(notices.flatMap((notice) => notice.targetId ? [notice.targetId] : []))];
      const recipients = [...new Set(notices.map((notice) => notice.recipient))];
      const matchTarget = targetIds.length ? inArray(accessNotificationsTable.targetId, targetIds) : undefined;
      const matchRecipient = inArray(accessNotificationsTable.recipient, recipients);
      if (targetIds.length || recipients.length) {
        await savepoint.update(accessNotificationsTable).set({ state: "cancelled" }).where(and(
          or(matchTarget, matchRecipient)!,
          eq(accessNotificationsTable.kind, "reporting"),
          inArray(accessNotificationsTable.state, ["pending", "confirming", "failed", "confirmed_failed"]),
        ));
      }
      await savepoint.insert(accessNotificationsTable).values(
        notices.map((notice) => ({ id: randomUUID(), ...notice })),
      );
    });
    return "queued";
  } catch {
    logger.warn({ event: "access_notification_queue_failed" }, "Access saved without an email notification");
    return "failed";
  }
}

// Clerk isn't in our DB transaction. Stage before calling Clerk, then attach
// this event ID to the same metadata write as the role. The worker can reconcile
// a process crash after Clerk succeeded but before our confirmation was saved.
export async function preparePlatformNotification(notice: Notice, targetId: string, role: AppRole) {
  const id = randomUUID();
  try {
    await db.insert(accessNotificationsTable).values({
      id, ...notice, targetId, platformRole: role, state: "confirming",
      nextAttemptAt: new Date(Date.now() + 120_000),
    });
    return id;
  } catch {
    logger.warn({ event: "access_notification_queue_failed" }, "Unable to queue platform access email");
    return null;
  }
}

export async function confirmPlatformNotification(id: string): Promise<void> {
  try {
    await db.update(accessNotificationsTable).set({ state: "pending", nextAttemptAt: new Date() })
      .where(eq(accessNotificationsTable.id, id));
  } catch {
    // The confirming row is durable and can be reconciled using Clerk metadata.
    logger.warn({ event: "access_notification_confirmation_deferred" }, "Email confirmation deferred");
  }
}

// Resend retains idempotency keys for 24h. Never retry an ambiguous attempt
// outside 23h: prefer an explicit failed record to a possible duplicate email.
export function retryAllowed(firstAttemptAt: Date | null, now: Date): boolean {
  return !firstAttemptAt || now.getTime() - firstAttemptAt.getTime() < 23 * 60 * 60 * 1000;
}

export async function listConfirmedFailedAccessNotifications() {
  const { rows } = await pool.query<{
    id: string; recipient: string; role_name: string; kind: "reporting" | "platform";
    created_at: Date; attempts: number;
  }>(`SELECT id, recipient, role_name, kind, created_at, attempts
      FROM wareiq_access_notifications
      WHERE state = 'confirmed_failed'
      ORDER BY created_at DESC LIMIT 100`);
  return rows;
}

export async function retryConfirmedFailedAccessNotification(id: string): Promise<boolean> {
  // Keep the same outbox ID (and provider idempotency key). Reset only the
  // deduplication window because a provider rejection confirmed no delivery.
  const { rows } = await pool.query<{ id: string }>(`UPDATE wareiq_access_notifications
      SET state = 'pending', first_attempt_at = NULL, next_attempt_at = now()
      WHERE id = $1 AND state = 'confirmed_failed'
      RETURNING id`, [id]);
  return rows.length === 1;
}

const connectors = new ReplitConnectors();
export async function deliverAccessNotifications(): Promise<void> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const { rows } = await connection.query<{
      id: string; recipient: string; role_name: string; kind: string; state: string;
      target_id: string | null; platform_role: string | null; first_attempt_at: Date | null; attempts: number;
    }>(`SELECT * FROM wareiq_access_notifications
        WHERE state IN ('pending', 'confirming') AND next_attempt_at <= now()
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const row = rows[0];
    if (!row) { await connection.query("COMMIT"); return; }
    if (row.state === "confirming") {
      // Never hold a notification row lock while waiting for the role lock:
      // role mutations take those locks in the opposite order.
      await connection.query("UPDATE wareiq_access_notifications SET next_attempt_at = now() + interval '2 minutes' WHERE id = $1", [row.id]);
      await connection.query("COMMIT");
      const confirmed = await withRoleLock(async () => {
        const user = await clerkClient.users.getUser(row.target_id!);
        return user.privateMetadata.wareiqRoleNotificationId === row.id &&
          user.publicMetadata.role === row.platform_role;
      });
      if (!confirmed) {
        await connection.query("UPDATE wareiq_access_notifications SET state = 'cancelled' WHERE id = $1", [row.id]);
        return;
      }
      await connection.query("BEGIN");
    }
    if (!retryAllowed(row.first_attempt_at, new Date())) {
      await connection.query("UPDATE wareiq_access_notifications SET state = 'failed' WHERE id = $1", [row.id]);
      await connection.query("COMMIT"); return;
    }
    // Commit the first-attempt time BEFORE any network IO. Otherwise a crash
    // after provider acceptance could reset the deduplication window.
    await connection.query(`UPDATE wareiq_access_notifications SET state = 'pending',
      first_attempt_at = coalesce(first_attempt_at, now()), attempts = attempts + 1,
      next_attempt_at = now() + interval '2 minutes' WHERE id = $1`, [row.id]);
    await connection.query("COMMIT");
    // Concurrent workers may reclaim after two minutes. They use the same key.
    try {
      const deliver = async () => {
        if (row.kind === "platform") {
          const user = await clerkClient.users.getUser(row.target_id!);
          if (user.privateMetadata.wareiqRoleNotificationId !== row.id ||
              user.publicMetadata.role !== row.platform_role) {
            await connection.query("BEGIN");
            await connection.query(
              "UPDATE wareiq_access_notifications SET state = 'cancelled' WHERE id = $1 AND state = 'pending'",
              [row.id],
            );
            await connection.query("COMMIT");
            return;
          }
        }

        // Recheck after acquiring the row lock: a newer role change may have
        // cancelled this notice after the claim was committed. Keep the lock
        // through delivery so a later change cannot overtake an in-flight send.
        await connection.query("BEGIN");
        const current = await connection.query<{ id: string }>(
          "SELECT * FROM wareiq_access_notifications WHERE id = $1 AND state = 'pending' FOR UPDATE",
          [row.id],
        );
        if (!current.rows.length) {
          await connection.query("COMMIT");
          return;
        }
        const response = await connectors.createProxyFetch("resend")("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": `wareiq-access/${row.id}` },
          body: JSON.stringify({ from: notificationSender, to: [row.recipient],
            ...notificationMessage(row.kind, row.role_name) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 408) {
            await connection.query(
              "UPDATE wareiq_access_notifications SET state = 'confirmed_failed' WHERE id = $1 AND state = 'pending'",
              [row.id],
            );
            await connection.query("COMMIT");
            logger.warn({ event: "access_notification_provider_rejected" }, "Access email was rejected by the provider");
            return;
          }
          throw new Error("Delivery rejected");
        }
        const result = await response.json() as { id?: string };
        if (!result.id) throw new Error("Delivery not confirmed");
        await connection.query("UPDATE wareiq_access_notifications SET state = 'sent' WHERE id = $1", [row.id]);
        await connection.query("COMMIT");
      };
      if (row.kind === "platform") await withRoleLock(deliver);
      else await deliver();
    } catch {
      await connection.query("ROLLBACK").catch(() => undefined);
      // Do not log provider responses: they may contain recipients or credentials.
      logger.warn({ event: "access_notification_delivery_failed" }, "Access email not confirmed; retry scheduled");
    }
  } catch {
    await connection.query("ROLLBACK").catch(() => undefined);
    logger.warn({ event: "access_notification_worker_failed" }, "Access email processing unavailable");
  } finally {
    connection.release();
  }
}

export function startAccessNotifications() {
  let running = false;
  let cleanupRunning = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await deliverAccessNotifications(); }
    catch { logger.warn({ event: "access_notification_worker_failed" }, "Access email processing unavailable"); }
    finally { running = false; }
  };
  const cleanup = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try { await cleanupCompletedAccessNotifications(); }
    catch {
      logger.warn({ event: "access_notification_cleanup_failed" }, "Completed access email cleanup unavailable");
    } finally {
      cleanupRunning = false;
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  const cleanupTimer = setInterval(() => void cleanup(), COMPLETED_NOTIFICATION_CLEANUP_INTERVAL_MS);
  timer.unref();
  cleanupTimer.unref();
  void tick();
  void cleanup();
}
