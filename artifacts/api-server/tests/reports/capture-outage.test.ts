import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { accessHistoryTable } from "@workspace/db/schema";
import {
  configureReportFixtureSuite, db, pauseDatabase, pool, resumeDatabase,
  startDatabase, stopDatabase,
} from "./database";

// Replace only the app database binding. The signature verifier, evidence
// writer, readiness reader, response schema and administrator guards are real.
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: (await import("./database")).db,
  pool: (await import("./database")).pool,
}));
const provider = vi.hoisted(() => ({
  userId: "user_admin" as string | null,
  getUser: vi.fn(async () => ({
    id: "user_admin", publicMetadata: { role: "admin" }, banned: false, locked: false,
    primaryEmailAddressId: "email_admin",
    emailAddresses: [{
      id: "email_admin", emailAddress: "admin@example.test", verification: { status: "verified" },
    }],
  })),
  warn: vi.fn(),
}));
// No live Clerk identity lookup. The webhook SDK subpath is NOT mocked.
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: provider.userId }),
  clerkClient: { users: { getUser: provider.getUser } },
}));
// These mutation-only dependencies must never be called by a readiness read.
vi.mock("../../src/lib/access-notifications", () => ({
  preparePlatformNotification: () => { throw new Error("Unexpected notification preparation"); },
  confirmPlatformNotification: () => { throw new Error("Unexpected notification confirmation"); },
}));

import webhookRouter from "../../src/routes/clerk-events";
import adminRouter from "../../src/routes/admin-users";
import { requireAdministrator, requireIdentity } from "../../src/middlewares/access";
import { captureConfiguration, captureReadiness } from "../../src/lib/capture-readiness";

configureReportFixtureSuite("capture-outage");
beforeAll(() => startDatabase());
afterAll(stopDatabase);
afterEach(() => vi.unstubAllEnvs());

const app = express();
app.use((req, _res, next) => {
  req.log = { warn: provider.warn } as unknown as typeof req.log;
  next();
});
// Match production: signed raw-body ingestion precedes cookie/identity guards.
app.use("/api", webhookRouter);
app.use("/api", requireIdentity);
app.use("/api/admin", requireAdministrator);
app.use("/api", adminRouter);

const secretBytes = Buffer.from("private-capture-outage-signing-fixture");
const eventId = "msg_outageReplay";
const webhookPath = "/api/webhooks/clerk/development";
const historyPath = "/api/admin/access-history";
function send(raw: string, signatureOverride?: string, deliveryId = eventId) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signatureOverride ?? `v1,${createHmac("sha256", secretBytes)
    .update(`${deliveryId}.${timestamp}.${raw}`).digest("base64")}`;
  return request(app).post(webhookPath).set("Content-Type", "application/json")
    .set("svix-id", deliveryId).set("svix-timestamp", timestamp)
    .set("svix-signature", signature).send(raw);
}
async function readReadiness() {
  const response = await request(app).get(historyPath);
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  return response.body;
}

it("does not let earlier verified evidence hide a later signed delivery failure after storage recovers", async () => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_outage");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", `whsec_${secretBytes.toString("base64")}`);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  const occurredAt = Date.now();
  const payload = {
    type: "user.updated", object: "event", timestamp: occurredAt, instance_id: "ins_outage",
    data: {
      id: "user_target", object: "user",
      public_metadata: { role: "admin", actor_id: "user_claimedActor", note: "never-retain" },
      private_metadata: { note: "never-retain" },
      email_addresses: [{ email_address: "never-retain@example.test" }],
    },
  };
  // Preserve exact raw bytes when replaying; only the delivery signature ages.
  const raw = JSON.stringify(payload, null, 2);
  expect((await readReadiness()).captureReadiness).toMatchObject({
    configuration: "configured", delivery: "unknown", lastVerifiedDeliveryAt: null,
    lastDeliveryFailureAt: null, failureScope: "environment_instance",
  });
  const earlierEventId = "msg_earlierSuccess";
  const earlierRaw = JSON.stringify({
    ...payload, timestamp: occurredAt - 1_000,
    data: { ...payload.data, public_metadata: { role: "supervisor" } },
  });
  provider.userId = null;
  expect((await send(earlierRaw, undefined, earlierEventId)).status).toBe(204);
  const earlierRows = await db.select().from(accessHistoryTable);
  expect(earlierRows).toHaveLength(1);
  expect(earlierRows[0]).toMatchObject({
    providerEventId: earlierEventId, resultingRole: "supervisor", outcome: "observed",
  });
  provider.userId = "user_admin";
  const earlierReadiness = (await readReadiness()).captureReadiness;
  expect(earlierReadiness).toMatchObject({
    delivery: "verified_delivery", lastVerifiedDeliveryAt: earlierRows[0]!.createdAt.toISOString(),
    lastDeliveryFailureAt: null,
  });
  provider.userId = null;
  expect((await request(app).get(historyPath)).status).toBe(401);

  let failureAt: string | null = null;
  const failureStartedAt = Date.now();
  await pauseDatabase();
  try {
    // This is valid HMAC authentication without a session, and a real failed
    // INSERT against the stopped Unix-socket-only cluster.
    const failed = await send(raw);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "Provider role evidence could not be saved." });
    expect(failed.headers["cache-control"]).toContain("no-store");
    expect(provider.warn).toHaveBeenCalledExactlyOnceWith(
      { code: "provider_evidence_write_failed" }, "Provider role evidence could not be saved",
    );
    const warning = captureReadiness(captureConfiguration(), earlierReadiness.lastVerifiedDeliveryAt);
    expect(warning).toMatchObject({
      delivery: "delivery_problem", lastVerifiedDeliveryAt: earlierReadiness.lastVerifiedDeliveryAt,
      failureScope: "environment_instance",
    });
    expect(Number.isFinite(Date.parse(warning.lastDeliveryFailureAt!))).toBe(true);
    failureAt = warning.lastDeliveryFailureAt;
    expect(Date.parse(failureAt!)).toBeGreaterThanOrEqual(failureStartedAt);
    expect(Date.parse(failureAt!)).toBeLessThanOrEqual(Date.now());
    provider.userId = "user_admin";
    // A database outage cannot be misreported as an empty, healthy history.
    const unavailable = await request(app).get(historyPath);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).not.toHaveProperty("captureReadiness");
  } finally {
    await resumeDatabase();
    provider.userId = "user_admin";
  }

  expect(await db.select().from(accessHistoryTable)).toEqual(earlierRows);
  const beforeReplay = await readReadiness();
  expect(beforeReplay.entries).toHaveLength(1);
  expect(beforeReplay.captureReadiness).toMatchObject({
    delivery: "delivery_problem", lastVerifiedDeliveryAt: earlierReadiness.lastVerifiedDeliveryAt,
    lastDeliveryFailureAt: failureAt, failureScope: "environment_instance",
  });
  // Storage recovery alone, invalid signatures and ignored signed events must
  // not clear the warning.
  expect((await send(raw, "v1,forged")).status).toBe(400);
  expect((await send(JSON.stringify({ ...payload, type: "user.created" }))).status).toBe(204);
  expect((await readReadiness()).captureReadiness).toEqual(beforeReplay.captureReadiness);

  expect((await send(raw)).status).toBe(204);
  const rows = await db.select().from(accessHistoryTable);
  expect(rows).toHaveLength(2);
  const replayed = rows.find((row) => row.providerEventId === eventId)!;
  expect(replayed).toMatchObject({
    actorId: "external:clerk", targetId: "user_target", outcome: "observed",
    reason: "provider_role_observed", resultingRole: "admin", previousRole: null,
    requestedRole: null, finishedAt: null, providerEventId: eventId,
    providerInstanceId: "ins_outage", providerEnvironment: "development",
    providerOccurredAt: new Date(occurredAt),
  });
  expect(rows.find((row) => row.providerEventId === earlierEventId)).toEqual(earlierRows[0]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  expect(JSON.stringify(rows)).not.toMatch(/never-retain|claimedActor|email_addresses|private_metadata/);
  const verified = await readReadiness();
  expect(verified.entries).toHaveLength(2);
  expect(verified.captureReadiness).toMatchObject({
    delivery: "verified_delivery", lastDeliveryFailureAt: null,
    lastVerifiedDeliveryAt: replayed.createdAt.toISOString(), failureScope: "environment_instance",
  });
  expect((await Promise.all(Array.from({ length: 4 }, (_, index) => index % 2
    ? send(raw) : send(earlierRaw, undefined, earlierEventId)))).map((r) => r.status))
    .toEqual([204, 204, 204, 204]);
  expect(await db.select().from(accessHistoryTable)).toEqual(rows);

  // Verify the evidence survives a server restart rather than relying on an
  // in-memory success flag or the returned INSERT result.
  await pauseDatabase();
  await resumeDatabase();
  expect((await readReadiness()).captureReadiness).toEqual(verified.captureReadiness);
  expect(await db.select().from(accessHistoryTable)).toEqual(rows);
  expect(pool.options.host).toMatch(/^\/.*wareiq-report-pg-/);
}, 20_000);
