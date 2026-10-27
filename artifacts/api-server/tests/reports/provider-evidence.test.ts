import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.unstubAllEnvs());
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

it("reads durable delivery evidence for the pinned instance independently of pagination", async () => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_test");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_isolated");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  expect((await accessHistoryPage()).captureReadiness.delivery).toBe("unknown");
  await recordProviderRoleObservation({ ...evidence, environment: "production" });
  await recordProviderRoleObservation({ ...evidence, instanceId: "ins_other" });
  // Unrelated stored observations are not evidence for the configured route.
  expect((await accessHistoryPage()).captureReadiness.delivery).toBe("unknown");
  await recordProviderRoleObservation(evidence);
  const oldReceipt = new Date("2020-01-01T00:00:00.000Z");
  await db.update(accessHistoryTable).set({ createdAt: oldReceipt })
    .where(eq(accessHistoryTable.providerInstanceId, "ins_test"));
  const first = await accessHistoryPage();
  expect(first.captureReadiness).toMatchObject({
    configuration: "configured", delivery: "verified_delivery", lastVerifiedDeliveryAt: oldReceipt.toISOString(),
  });
  const older = await accessHistoryPage({
    beforeTime: "2019-01-01T00:00:00.000Z", beforeId: "c747e2d6-7ca8-4558-8af5-3c59ff419a46",
  });
  expect(older.entries).toEqual([]);
  expect(older.captureReadiness).toEqual(first.captureReadiness);
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_neverDelivered");
  expect((await accessHistoryPage()).captureReadiness.delivery).toBe("unknown");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "");
  expect((await accessHistoryPage()).captureReadiness.delivery).toBe("not_configured");
});
