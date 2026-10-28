import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, captureDiagnosticsTable as table } from "./index";

type Scope = { environment: "development" | "production"; instanceId: string };
function scoped(scope: Scope) {
  if (!["development", "production"].includes(scope.environment) || !/^ins_[A-Za-z0-9]+$/.test(scope.instanceId)) {
    throw new Error("Invalid capture diagnostic scope");
  }
  return and(eq(table.environment, scope.environment), eq(table.instanceId, scope.instanceId));
}

// Commit before trying the evidence write. A crash/outage afterwards leaves an
// explicitly uncertain attempt, never a fabricated confirmed storage failure.
export async function beginCaptureDelivery(scope: Scope) {
  scoped(scope);
  const attemptId = randomUUID();
  await db.insert(table).values({ ...scope, attemptId, status: "pending" })
    .onConflictDoUpdate({
      target: [table.environment, table.instanceId],
      set: { attemptId, status: "pending", attemptedAt: sql`clock_timestamp()` },
    });
  return attemptId;
}

// Compare-and-set prevents a slower replica completing an older attempt from
// overwriting a newer attempt's diagnostic.
export async function finishCaptureDelivery(scope: Scope, attemptId: string, succeeded: boolean) {
  await db.update(table).set({ status: succeeded ? "succeeded" : "failed" })
    .where(and(scoped(scope), eq(table.attemptId, attemptId)));
}

export async function readCaptureDiagnostic(scope: Scope) {
  const [row] = await db.select({ status: table.status, attemptedAt: table.attemptedAt })
    .from(table).where(scoped(scope)).limit(1);
  return row ?? null;
}
