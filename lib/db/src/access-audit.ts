import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, accessHistoryTable } from "./index";
import type { AccessAuditStore } from "./access-audit-types";

export type ProviderRoleObservation = {
  eventId: string;
  instanceId: string;
  environment: "development" | "production";
  occurredAt: Date;
  targetId: string;
  role: "admin" | "supervisor" | "unassigned";
};

// One atomic, append-only insert. The unique index also covers concurrent
// delivery and provider replays signed with a fresh delivery timestamp.
export async function recordProviderRoleObservation(entry: ProviderRoleObservation): Promise<void> {
  await db.insert(accessHistoryTable).values({
    id: randomUUID(),
    actorId: "external:clerk",
    targetId: entry.targetId,
    previousRole: null,
    requestedRole: null,
    resultingRole: entry.role,
    outcome: "observed",
    reason: "provider_role_observed",
    providerEventId: entry.eventId,
    providerInstanceId: entry.instanceId,
    providerEnvironment: entry.environment,
    providerOccurredAt: entry.occurredAt,
    finishedAt: null,
  }).onConflictDoNothing({
    target: [
      accessHistoryTable.providerEnvironment,
      accessHistoryTable.providerInstanceId,
      accessHistoryTable.providerEventId,
    ],
  });
}

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
  let connectionError: Error | undefined;
  // Checked-out clients have no pool error listener. PostgreSQL can disconnect
  // while we await the provider, not just while a query is pending.
  const onError = (error: Error) => { connectionError ??= error; };
  connection.on("error", onError);
  const assertConnected = () => {
    if (connectionError) throw connectionError;
  };
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SELECT pg_advisory_xact_lock(174983, 1)");
    assertConnected();
    // Let dispatched work settle: rejecting a race cannot cancel a provider
    // write and would leave that callback running after its caller has failed.
    const result = await operation();
    assertConnected();
    await connection.query("COMMIT");
    assertConnected();
    return result;
  } catch (error) {
    if (!connectionError) {
      await connection.query("ROLLBACK").catch((rollbackError: Error) => {
        connectionError ??= rollbackError;
      });
    }
    throw connectionError ?? error;
  } finally {
    // Destroy rather than recycle failed clients. Keep our listener until
    // release has handed error ownership back to the pool (or removed it).
    connection.release(connectionError);
    connection.removeListener("error", onError);
  }
}
