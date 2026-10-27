import { randomUUID } from "node:crypto";
import { db, accessHistoryTable } from "@workspace/db";
import { desc, eq, lt, or, and } from "drizzle-orm";
import type { AccessAuditStore } from "./audited-role-change";

export const accessAuditStore: AccessAuditStore = {
  async start(entry) {
    const id = randomUUID();
    await db.insert(accessHistoryTable).values({
      id, ...entry,
      finishedAt: entry.outcome ? new Date() : null,
    });
    return id;
  },
  async previous(id, previousRole) {
    await db.update(accessHistoryTable).set({ previousRole }).where(eq(accessHistoryTable.id, id));
  },
  async finish(id, outcome, reason, resultingRole) {
    await db.update(accessHistoryTable).set({
      outcome, reason, resultingRole: resultingRole ?? null, finishedAt: new Date(),
    }).where(eq(accessHistoryTable.id, id));
  },
};

// Stable keyset pagination: new changes cannot shift older pages.
export async function accessHistoryPage(cursor?: { beforeTime: string; beforeId: string }) {
  const rows = await db.select().from(accessHistoryTable).where(cursor ? or(
    lt(accessHistoryTable.createdAt, new Date(cursor.beforeTime)),
    and(eq(accessHistoryTable.createdAt, new Date(cursor.beforeTime)), lt(accessHistoryTable.id, cursor.beforeId)),
  ) : undefined).orderBy(desc(accessHistoryTable.createdAt), desc(accessHistoryTable.id)).limit(26);
  const entries = rows.slice(0, 25);
  const last = entries.at(-1);
  return {
    entries: entries.map((row) => ({
      ...row, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > 25 && last ? { beforeTime: last.createdAt.toISOString(), beforeId: last.id } : null,
  };
}
