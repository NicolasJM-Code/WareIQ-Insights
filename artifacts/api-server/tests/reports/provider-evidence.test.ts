import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { configureReportFixtureSuite, db, pool, startDatabase, stopDatabase } from "./database";
import { accessHistoryTable } from "@workspace/db/schema";

vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: (await import("./database")).db,
  pool: (await import("./database")).pool,
}));
import { accessAuditStore, recordProviderRoleObservation } from "@workspace/db/access-audit";
import { accessHistoryPage } from "../../src/lib/access-history";

configureReportFixtureSuite("provider-evidence");
beforeAll(() => startDatabase());
afterAll(stopDatabase);
beforeEach(async () => { await pool.query("TRUNCATE access_change_history"); });
const evidence = {
  eventId: "msg_same", instanceId: "ins_test", environment: "development" as const,
  occurredAt: new Date("2026-10-20T12:00:00.000Z"), targetId: "user_target", role: "admin" as const,
  actorId: "user_claimedActor", email: "never-store@example.test", metadata: "never-store",
};

it("deduplicates concurrent deliveries and replays with a database unique constraint", async () => {
  await Promise.all(Array.from({ length: 8 }, () => recordProviderRoleObservation(evidence)));
  await recordProviderRoleObservation(evidence);
  const rows = await db.select().from(accessHistoryTable);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actorId: "external:clerk", targetId: "user_target", outcome: "observed",
    reason: "provider_role_observed", previousRole: null, requestedRole: null,
    resultingRole: "admin", providerOccurredAt: evidence.occurredAt, finishedAt: null,
  });
  expect(JSON.stringify(rows)).not.toMatch(/never-store|claimedActor|metadata|email/);
});
it("scopes deduplication to the routed provider environment and instance", async () => {
  await recordProviderRoleObservation(evidence);
  await recordProviderRoleObservation({ ...evidence, environment: "production" });
  await recordProviderRoleObservation({ ...evidence, instanceId: "ins_other" });
  expect(await db.select().from(accessHistoryTable)).toHaveLength(3);
});
it("preserves late observations and never reconciles an earlier unconfirmed Settings intent", async () => {
  const id = await accessAuditStore.start({ actorId: "user_admin", targetId: "user_target", requestedRole: "admin" });
  await recordProviderRoleObservation(evidence);
  await recordProviderRoleObservation({
    ...evidence, eventId: "msg_late", occurredAt: new Date("2026-10-19T12:00:00.000Z"), role: "unassigned",
  });
  const [intent] = await db.select().from(accessHistoryTable).where(eq(accessHistoryTable.id, id));
  expect(intent).toMatchObject({
    outcome: "unconfirmed", resultingRole: null, finishedAt: null, providerEventId: null,
  });
  const page = await accessHistoryPage();
  expect(page.entries).toHaveLength(3);
  const observations = page.entries.filter((entry) => entry.outcome === "observed");
  expect(observations.map((entry) => entry.providerOccurredAt).sort()).toEqual([
    "2026-10-19T12:00:00.000Z", "2026-10-20T12:00:00.000Z",
  ]);
  expect(observations.every((entry) => entry.previousRole === null && entry.requestedRole === null)).toBe(true);
});
