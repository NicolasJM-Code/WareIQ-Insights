import { db, accessHistoryTable } from "@workspace/db";
import { desc, eq, lt, or, and } from "drizzle-orm";
import { captureConfiguration, captureReadiness } from "./capture-readiness";
import { readCaptureDiagnostic } from "@workspace/db/capture-diagnostics";
import type { CaptureDiagnostic } from "./capture-readiness";
export { accessAuditStore } from "@workspace/db/access-audit";

// Stable keyset pagination: new changes cannot shift older pages.
export async function accessHistoryPage(cursor?: { beforeTime: string; beforeId: string }) {
  const rows = await db.select().from(accessHistoryTable).where(cursor ? or(
    lt(accessHistoryTable.createdAt, new Date(cursor.beforeTime)),
    and(eq(accessHistoryTable.createdAt, new Date(cursor.beforeTime)), lt(accessHistoryTable.id, cursor.beforeId)),
  ) : undefined).orderBy(desc(accessHistoryTable.createdAt), desc(accessHistoryTable.id)).limit(26);
  const entries = rows.slice(0, 25);
  const last = entries.at(-1);
  const configuration = captureConfiguration();
  // Independent of the requested history page and restricted to this route's
  // pinned instance/environment. No event frequency or subscription inference.
  const verified = configuration.routing ? await db.select({ createdAt: accessHistoryTable.createdAt })
    .from(accessHistoryTable).where(and(
      eq(accessHistoryTable.outcome, "observed"),
      eq(accessHistoryTable.reason, "provider_role_observed"),
      eq(accessHistoryTable.providerInstanceId, configuration.instanceId!),
      eq(accessHistoryTable.providerEnvironment, configuration.environment!),
    )).orderBy(desc(accessHistoryTable.createdAt)).limit(1) : [];
  let diagnostic: CaptureDiagnostic = null;
  if (configuration.routing) {
    try {
      diagnostic = await readCaptureDiagnostic({
        environment: configuration.environment as "development" | "production",
        instanceId: configuration.instanceId!,
      });
    } catch {
      diagnostic = "unavailable";
    }
  }
  return {
    captureReadiness: captureReadiness(configuration, verified[0]?.createdAt.toISOString() ?? null, diagnostic),
    entries: entries.map((row) => ({
      ...row, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
      providerOccurredAt: row.providerOccurredAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > 25 && last ? { beforeTime: last.createdAt.toISOString(), beforeId: last.id } : null,
  };
}
