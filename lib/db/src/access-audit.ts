import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, accessHistoryTable } from "./index";
import type { AccessAuditStore } from "./access-audit-types";

// Explicit projection prevents accidentally persisting provider payloads.
// All evidence writes use the pool, independently of the role-lock transaction.
export const accessAuditStore: AccessAuditStore & {
  target: (id: string, targetId: string) => Promise<void>;
} = {
  async start(entry) {
    const id = randomUUID();
    await db.insert(accessHistoryTable).values({
      id, actorId: entry.actorId, targetId: entry.targetId,
      requestedRole: entry.requestedRole, outcome: entry.outcome,
      reason: entry.reason, finishedAt: entry.outcome ? new Date() : null,
    });
    return id;
  },
  async previous(id, previousRole) {
    await db.update(accessHistoryTable).set({ previousRole }).where(eq(accessHistoryTable.id, id));
  },
  async target(id, targetId) {
    await db.update(accessHistoryTable).set({ targetId }).where(eq(accessHistoryTable.id, id));
  },
  async finish(id, outcome, reason, resultingRole) {
    await db.update(accessHistoryTable).set({
      outcome, reason, resultingRole: resultingRole ?? null, finishedAt: new Date(),
    }).where(eq(accessHistoryTable.id, id));
  },
};

// Shared by Settings and the owner-operated recovery command. Never WMS.
export async function withRoleLock<T>(operation: () => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SELECT pg_advisory_xact_lock(174983, 1)");
    const result = await operation();
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
