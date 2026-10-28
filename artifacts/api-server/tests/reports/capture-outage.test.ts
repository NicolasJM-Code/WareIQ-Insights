import { createHmac } from "node:crypto";
import express from "express";
import request, { type Response } from "supertest";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { accessHistoryTable, captureDiagnosticsTable } from "@workspace/db/schema";
import {
  configureReportFixtureSuite, db, pauseDatabase, pool, resumeDatabase,
  socketDirectory, startDatabase, stopDatabase,
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

it.each([
  { olderSucceeds: true, instanceId: "ins_overlapSuccess", lockKey: 16401 },
  { olderSucceeds: false, instanceId: "ins_overlapFailure", lockKey: 16402 },
])("keeps the newer completed delivery authoritative when older success=$olderSucceeds finishes last", async ({
  olderSucceeds, instanceId, lockKey,
}) => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", instanceId);
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", `whsec_${secretBytes.toString("base64")}`);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  provider.userId = "user_admin";
  provider.warn.mockClear();
  const raw = JSON.stringify({
    type: "user.updated", object: "event", timestamp: Date.now(), instance_id: instanceId,
    data: { id: "user_target", object: "user", public_metadata: { role: "admin" } },
  });
  const baselineId = `msg_baseline${lockKey}`;
  const olderId = `msg_older${lockKey}`;
  const newerId = `msg_newer${lockKey}`;
  expect((await send(raw, undefined, baselineId)).status).toBe(204);
  const baseline = (await readReadiness()).captureReadiness;
  expect(baseline).toMatchObject({ delivery: "verified_delivery", lastDeliveryFailureAt: null });

  // Only this private cluster has these triggers. Real INSERTs wait on a
  // session-held advisory lock or fail in PostgreSQL; no writer/verifier mock
  // can accidentally manufacture the desired completion order.
  await pool.query(`
    CREATE TABLE capture_overlap_control (
      instance_id text PRIMARY KEY, blocked_event_id text NOT NULL,
      fail_blocked boolean NOT NULL, reject_begin boolean NOT NULL,
      lock_key integer NOT NULL
    );
    CREATE FUNCTION control_capture_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE control capture_overlap_control%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME = 'capture_delivery_diagnostics' THEN
        SELECT * INTO control FROM capture_overlap_control WHERE instance_id = NEW.instance_id;
        IF control.reject_begin THEN
          RAISE EXCEPTION 'Synthetic pending-marker storage failure';
        END IF;
      ELSE
        SELECT * INTO control FROM capture_overlap_control
          WHERE instance_id = NEW.provider_instance_id AND blocked_event_id = NEW.provider_event_id;
        IF FOUND THEN
          PERFORM pg_advisory_xact_lock(control.lock_key::bigint);
          IF control.fail_blocked THEN
            RAISE EXCEPTION 'Synthetic evidence storage failure';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER capture_overlap_evidence BEFORE INSERT ON access_change_history
      FOR EACH ROW EXECUTE FUNCTION control_capture_overlap();
    CREATE TRIGGER capture_overlap_begin BEFORE INSERT ON capture_delivery_diagnostics
      FOR EACH ROW EXECUTE FUNCTION control_capture_overlap();
  `);
  // A separate connection holds the barrier, leaving the fixture pool's second
  // connection free for the newer delivery and administrator history reads.
  const barrier = new Client(pool.options);
  let older: Promise<request.Response> | undefined;
  try {
    await barrier.connect();
    await barrier.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
    await pool.query("INSERT INTO capture_overlap_control VALUES ($1, $2, $3, false, $4)",
      [instanceId, olderId, !olderSucceeds, lockKey]);
    older = send(raw, undefined, olderId).then((response) => response);
    // Observe the actual blocked SQL write, not a timer or request dispatch.
    // Its pending diagnostic must already have committed at this point.
    await expect.poll(async () => {
      const result = await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted",
        [lockKey],
      );
      return result.rows[0].waiting;
    }).toBe(1);
    expect((await readReadiness()).captureReadiness).toMatchObject({
      delivery: "delivery_unknown", lastDeliveryFailureAt: null,
      lastVerifiedDeliveryAt: baseline.lastVerifiedDeliveryAt,
    });

    if (olderSucceeds) {
      // Fail BEFORE the newer pending marker can commit. Otherwise its durable
      // failed row would mask a broken process-local sequence guard.
      await pool.query("UPDATE capture_overlap_control SET reject_begin = true");
    }
    const newerStartedAt = Date.now();
    const newer = await send(raw, undefined, newerId);
    expect(newer.status).toBe(olderSucceeds ? 503 : 204);
    expect(newer.headers["cache-control"]).toContain("no-store");
    if (olderSucceeds) {
      expect(newer.body).toEqual({ error: "Provider role evidence could not be saved." });
    }
    const afterNewer = (await readReadiness()).captureReadiness;
    expect(afterNewer).toMatchObject({
      delivery: olderSucceeds ? "delivery_problem" : "verified_delivery",
      failureScope: "environment_instance",
    });
    if (olderSucceeds) {
      expect(Date.parse(afterNewer.lastDeliveryFailureAt)).toBeGreaterThanOrEqual(newerStartedAt);
      expect(Date.parse(afterNewer.lastDeliveryFailureAt)).toBeLessThanOrEqual(Date.now());
      expect(afterNewer.lastVerifiedDeliveryAt).toBe(baseline.lastVerifiedDeliveryAt);
    } else {
      expect(afterNewer.lastDeliveryFailureAt).toBeNull();
    }

    await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
    const delayed = await older;
    expect(delayed.status).toBe(olderSucceeds ? 204 : 503);
    expect(delayed.headers["cache-control"]).toContain("no-store");
    if (!olderSucceeds) {
      expect(delayed.body).toEqual({ error: "Provider role evidence could not be saved." });
    }
    const history = await readReadiness();
    // Completion of an older attempt must neither clear a newer local failure
    // nor restore an older failure over a newer success.
    expect(history.captureReadiness).toMatchObject({
      delivery: afterNewer.delivery, lastDeliveryFailureAt: afterNewer.lastDeliveryFailureAt,
      failureScope: "environment_instance",
    });
    const rows = (await db.select().from(accessHistoryTable))
      .filter((row) => row.providerInstanceId === instanceId);
    expect(rows.map((row) => row.providerEventId).sort())
      .toEqual([baselineId, olderSucceeds ? olderId : newerId].sort());
    const successful = rows.find((row) => row.providerEventId === (olderSucceeds ? olderId : newerId))!;
    expect(history.captureReadiness.lastVerifiedDeliveryAt).toBe(successful.createdAt.toISOString());
    expect(history.entries.some((entry: { id: string }) => entry.id === successful.id)).toBe(true);
    const diagnostic = await pool.query(
      "SELECT status FROM capture_delivery_diagnostics WHERE instance_id = $1", [instanceId],
    );
    expect(diagnostic.rows).toEqual([{ status: "succeeded" }]);
    expect(provider.warn).toHaveBeenCalledExactlyOnceWith(
      { code: "provider_evidence_write_failed" }, "Provider role evidence could not be saved",
    );
    // Repeated administrator reads cannot clear the process-local warning.
    expect((await readReadiness()).captureReadiness).toEqual(history.captureReadiness);
    await pool.query("UPDATE capture_overlap_control SET reject_begin = false");
    expect((await send(raw, undefined, `msg_recovery${lockKey}`)).status).toBe(204);
    expect((await readReadiness()).captureReadiness).toMatchObject({
      delivery: "verified_delivery", lastDeliveryFailureAt: null,
    });
  } finally {
    // Release and settle the HTTP request even if an assertion fails, before
    // removing triggers or allowing the suite to stop its private database.
    await barrier.end();
    await older;
    await pool.query(`
      DROP TRIGGER capture_overlap_evidence ON access_change_history;
      DROP TRIGGER capture_overlap_begin ON capture_delivery_diagnostics;
      DROP FUNCTION control_capture_overlap();
      DROP TABLE capture_overlap_control;
    `);
  }
}, 20_000);

it.each([
  { earlierSucceeds: true, laterSucceeds: false },
  { earlierSucceeds: false, laterSucceeds: true },
])("keeps the newer signed outcome when earlier success=$earlierSucceeds finishes after later success=$laterSucceeds", async ({
  earlierSucceeds, laterSucceeds,
}) => {
  const instanceId = earlierSucceeds ? "ins_overlapLaterFailure" : "ins_overlapLaterSuccess";
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", instanceId);
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", `whsec_${secretBytes.toString("base64")}`);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  provider.userId = "user_admin";
  provider.warn.mockClear();
  const configuration = captureConfiguration();
  const raw = (succeeds: boolean) => JSON.stringify({
    type: "user.updated", object: "event", timestamp: Date.now(), instance_id: instanceId,
    data: {
      id: succeeds ? "user_overlapSuccess" : "user_overlapFailure", object: "user",
      public_metadata: { role: "admin" },
    },
  });
  const earlierRaw = raw(earlierSucceeds);
  const laterRaw = raw(laterSucceeds);
  const evidence = () => db.select().from(accessHistoryTable)
    .where(eq(accessHistoryTable.providerInstanceId, instanceId));
  const diagnostic = async () => {
    const rows = await db.select().from(captureDiagnosticsTable)
      .where(eq(captureDiagnosticsTable.instanceId, instanceId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const initial = (await readReadiness()).captureReadiness;
  expect(initial).toMatchObject({ delivery: "unknown", lastDeliveryFailureAt: null });

  // A third, fixture-only connection holds the gate, leaving both application
  // pool slots available. No production writer, diagnostic or verifier is mocked.
  const gate = new Client({
    host: socketDirectory, port: 5432, user: "report_test", database: "postgres", password: "",
  });
  await gate.connect();
  let earlier: Promise<Response> | undefined;
  try {
    await gate.query("SELECT pg_advisory_lock(193, 1)");
    await pool.query(`
      CREATE FUNCTION overlap_capture_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provider_event_id = 'msg_overlapEarlier' THEN
          PERFORM pg_advisory_xact_lock(193, 1);
        END IF;
        IF NEW.target_id = 'user_overlapFailure' THEN
          RAISE EXCEPTION 'synthetic private fixture evidence failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER overlap_capture_evidence BEFORE INSERT ON access_change_history
        FOR EACH ROW EXECUTE FUNCTION overlap_capture_evidence();
    `);
    // Calling then starts Supertest immediately, rather than awaiting it later
    // and accidentally testing two sequential requests.
    earlier = send(earlierRaw, undefined, "msg_overlapEarlier").then((response) => response);
    await vi.waitFor(async () => {
      const blocked = await pool.query(`
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND classid = 193 AND objid = 1 AND NOT granted
      `);
      expect(blocked.rows).toHaveLength(1);
    }, { timeout: 4_000, interval: 10 });
    const pending = await diagnostic();
    expect(pending.status).toBe("pending");
    expect(await evidence()).toEqual([]);
    expect((await readReadiness()).captureReadiness).toMatchObject({
      delivery: "delivery_unknown", lastDeliveryFailureAt: null,
    });

    const later = await send(laterRaw, undefined, "msg_overlapLater");
    expect(later.status).toBe(laterSucceeds ? 204 : 503);
    expect(later.headers["cache-control"]).toContain("no-store");
    if (!laterSucceeds) {
      expect(later.body).toEqual({ error: "Provider role evidence could not be saved." });
    }
    const latest = await diagnostic();
    expect(latest.attemptId).not.toBe(pending.attemptId);
    expect(latest.status).toBe(laterSucceeds ? "succeeded" : "failed");
    const expectedDelivery = laterSucceeds ? "verified_delivery" : "delivery_problem";
    const beforeRelease = (await readReadiness()).captureReadiness;
    expect(beforeRelease.delivery).toBe(expectedDelivery);
    // Without a durable diagnostic supplied, this directly checks the route's
    // local outcome independently of the PostgreSQL compare-and-set.
    const localBefore = captureReadiness(configuration, beforeRelease.lastVerifiedDeliveryAt);
    expect(localBefore.delivery).toBe(expectedDelivery);
    if (!laterSucceeds) {
      expect(Number.isFinite(Date.parse(localBefore.lastDeliveryFailureAt!))).toBe(true);
    } else {
      expect(localBefore.lastDeliveryFailureAt).toBeNull();
    }
    const successfulEventId = earlierSucceeds ? "msg_overlapEarlier" : "msg_overlapLater";
    const beforeRows = await evidence();
    expect(beforeRows).toHaveLength(laterSucceeds ? 1 : 0);

    await gate.query("SELECT pg_advisory_unlock(193, 1)");
    const delayed = await earlier;
    expect(delayed.status).toBe(earlierSucceeds ? 204 : 503);
    expect(delayed.headers["cache-control"]).toContain("no-store");
    if (!earlierSucceeds) {
      expect(delayed.body).toEqual({ error: "Provider role evidence could not be saved." });
    }
    // The older completion really reached the production finish path, but
    // cannot change the newer attempt's identity, status or timestamp.
    expect(await diagnostic()).toEqual(latest);
    const rows = await evidence();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerEventId: successfulEventId, outcome: "observed" });
    const afterRelease = (await readReadiness()).captureReadiness;
    expect(afterRelease).toMatchObject({
      delivery: expectedDelivery, lastDeliveryFailureAt: beforeRelease.lastDeliveryFailureAt,
      lastVerifiedDeliveryAt: rows[0]!.createdAt.toISOString(),
    });
    expect(captureReadiness(configuration, beforeRelease.lastVerifiedDeliveryAt)).toEqual(localBefore);
    expect(provider.warn).toHaveBeenCalledExactlyOnceWith(
      { code: "provider_evidence_write_failed" }, "Provider role evidence could not be saved",
    );

    // Remove only the synthetic failure, then replay both exact signed events.
    // The failed event recovers; repeated successful evidence keeps its UUID
    // and receipt time despite overlapping retries.
    await pool.query("DROP TRIGGER overlap_capture_evidence ON access_change_history");
    expect((await Promise.all(Array.from({ length: 4 }, (_, index) => index % 2
      ? send(earlierRaw, undefined, "msg_overlapEarlier")
      : send(laterRaw, undefined, "msg_overlapLater")))).map((response) => response.status))
      .toEqual([204, 204, 204, 204]);
    const replayed = await evidence();
    expect(replayed).toHaveLength(2);
    expect(new Set(replayed.map((row) => row.providerEventId))).toEqual(
      new Set(["msg_overlapEarlier", "msg_overlapLater"]),
    );
    expect(replayed.find((row) => row.providerEventId === successfulEventId)).toEqual(rows[0]);
    expect((await diagnostic()).status).toBe("succeeded");
    expect((await readReadiness()).captureReadiness).toMatchObject({
      delivery: "verified_delivery", lastDeliveryFailureAt: null,
    });
    expect(captureReadiness(configuration, rows[0]!.createdAt.toISOString())).toMatchObject({
      delivery: "verified_delivery", lastDeliveryFailureAt: null,
    });
  } finally {
    // Always unblock and drain the HTTP request before changing its trigger or
    // stopping the cluster, including when an assertion above fails.
    await gate.query("SELECT pg_advisory_unlock_all()");
    await earlier;
    await pool.query(`
      DROP TRIGGER IF EXISTS overlap_capture_evidence ON access_change_history;
      DROP FUNCTION IF EXISTS overlap_capture_evidence();
    `);
    await gate.end();
  }
}, 15_000);
