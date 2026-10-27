import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const store = vi.hoisted(() => ({ record: vi.fn(), warn: vi.fn() }));
vi.mock("@workspace/db/access-audit", () => ({ recordProviderRoleObservation: store.record }));
// The signature verifier is deliberately REAL, not mocked.
import router from "../src/routes/clerk-events";
import { captureConfiguration, captureReadiness, noteCaptureDelivery } from "../src/lib/capture-readiness";

const app = express();
app.use((req, _res, next) => { req.log = { warn: store.warn } as unknown as typeof req.log; next(); });
app.use("/api", router);
app.use((_req, res) => { res.sendStatus(401); });
const secretBytes = Buffer.from("isolated-webhook-signing-test-key");
const secret = `whsec_${secretBytes.toString("base64")}`;
const path = "/api/webhooks/clerk/development";
const now = Date.now();
const body = (role: unknown = "admin", timestamp = now) => ({
  type: "user.updated", object: "event", timestamp, instance_id: "ins_test",
  data: {
    id: "user_target", object: "user",
    public_metadata: { role, actor_id: "user_claimedAdmin", private_note: "never retain" },
    private_metadata: { operator: "never retain" }, email_addresses: [{ email_address: "private@example.test" }],
  },
  event_attributes: { actor: "user_claimedAdmin" },
});
function send(payload: unknown, options: { id?: string; timestamp?: number; signature?: string; path?: string } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const id = options.id ?? "msg_delivery1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = options.signature ?? `v1,${createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
  return request(app).post(options.path ?? path).set("Content-Type", "application/json")
    .set("svix-id", id).set("svix-timestamp", timestamp).set("svix-signature", signature).send(raw);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_test");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  noteCaptureDelivery(captureConfiguration(), true);
  store.record.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("authenticates exact bytes without a cookie or Origin and projects role evidence only", async () => {
  expect((await send(JSON.stringify(body(), null, 2))).status).toBe(204);
  expect(store.record).toHaveBeenCalledExactlyOnceWith({
    eventId: "msg_delivery1", environment: "development", instanceId: "ins_test",
    occurredAt: new Date(now), targetId: "user_target", role: "admin",
  });
  expect(JSON.stringify(store.record.mock.calls)).not.toMatch(/private|claimedAdmin|actor|operator|email/);
});
it("acknowledges duplicate signed delivery while retaining the stable deduplication key", async () => {
  expect((await send(body())).status).toBe(204);
  expect((await send(body())).status).toBe(204);
  expect(store.record).toHaveBeenCalledTimes(2);
  expect(store.record.mock.calls[0]).toEqual(store.record.mock.calls[1]);
  // The production database writer's unique-index behavior is exercised in
  // reports/provider-evidence.test.ts, including parallel delivery.
});
it("enforces the raw payload limit before any evidence is stored", async () => {
  expect((await send({ ...body(), ignored: "x".repeat(256 * 1024) })).status).toBe(413);
  expect(store.record).not.toHaveBeenCalled();
});
it("rejects forged, missing, tampered and stale signatures without touching storage", async () => {
  expect((await send(body(), { signature: "v1,forged" })).status).toBe(400);
  expect((await request(app).post(path).send(body())).status).toBe(400);
  expect((await send(body(), { timestamp: Math.floor(Date.now() / 1000) - 601 })).status).toBe(400);
  const data = JSON.stringify(body());
  const ts = Math.floor(Date.now() / 1000);
  const signature = `v1,${createHmac("sha256", secretBytes).update(`msg_delivery1.${ts}.${data}`).digest("base64")}`;
  expect((await send(`${data} `, { signature, timestamp: ts })).status).toBe(400);
  expect(store.record).not.toHaveBeenCalled();
});
it("fails closed when configuration is absent or belongs to another environment or instance", async () => {
  expect((await send(body(), { path: "/api/webhooks/clerk/production" })).status).toBe(403);
  expect((await send({ ...body(), instance_id: "ins_other" })).status).toBe(403);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_live_wrongEnvironment");
  expect((await send(body())).status).toBe(503);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "");
  expect((await send(body())).status).toBe(503);
  expect(store.record).not.toHaveBeenCalled();
});
it("routes production only with an explicit production key, instance and signature", async () => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "production");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_live_isolated");
  expect((await send(body(), { path: "/api/webhooks/clerk/production" })).status).toBe(204);
  expect(store.record).toHaveBeenCalledWith(expect.objectContaining({ environment: "production" }));
  expect((await send(body())).status).toBe(403);
});
it("allows missing actor evidence and a removed role, never inventing actor or previous role", async () => {
  const event = body(null);
  delete (event as Partial<typeof event>).event_attributes;
  event.data.public_metadata = { role: null, actor_id: "", private_note: "" };
  expect((await send(event)).status).toBe(204);
  expect(store.record).toHaveBeenCalledWith(expect.objectContaining({ role: "unassigned" }));
  expect(store.record.mock.calls[0]![0]).not.toHaveProperty("actorId");
  expect(store.record.mock.calls[0]![0]).not.toHaveProperty("previousRole");
});
it("accepts late historical events independently rather than treating delivery order as role order", async () => {
  expect((await send(body("admin", now), { id: "msg_newer" })).status).toBe(204);
  expect((await send(body("unassigned", now - 86400_000), { id: "msg_older" })).status).toBe(204);
  expect(store.record.mock.calls.map(([entry]) => [entry.role, entry.occurredAt.getTime()])).toEqual([
    ["admin", now], ["unassigned", now - 86400_000],
  ]);
});
it("ignores unrelated events and unknown roles and rejects malformed evidence", async () => {
  expect((await send({ ...body(), type: "user.created" })).status).toBe(204);
  expect((await send(body("superadmin"))).status).toBe(204);
  expect((await send({ ...body(), timestamp: "yesterday" })).status).toBe(400);
  expect((await send({ ...body(), data: {} })).status).toBe(400);
  expect(store.record).not.toHaveBeenCalled();
});
it("returns a retryable failure on storage errors without logging provider details", async () => {
  store.record.mockRejectedValue(new Error("private provider details"));
  expect((await send(body())).status).toBe(503);
  expect(store.warn).toHaveBeenCalledExactlyOnceWith(
    { code: "provider_evidence_write_failed" }, "Provider role evidence could not be saved",
  );
  expect(captureReadiness(captureConfiguration(), null).delivery).toBe("delivery_problem");
  // Forged, wrong-instance, ignored or malformed deliveries cannot clear a
  // genuine failure, nor count as successful role capture.
  await send(body(), { signature: "v1,forged" });
  await send({ ...body(), instance_id: "ins_other" });
  await send({ ...body(), type: "user.created" });
  await send(body("unknown"));
  await send({ ...body(), data: {} });
  expect(captureReadiness(captureConfiguration(), null).delivery).toBe("delivery_problem");
  store.record.mockResolvedValue(undefined);
  expect((await send(body())).status).toBe(204);
  expect(captureReadiness(captureConfiguration(), null).delivery).toBe("unknown");
});
