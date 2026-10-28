import { createHmac } from "node:crypto";
import type {} from "pino-http";
import express from "express";
import request from "supertest";
import { pool } from "@workspace/db";
import { beginCaptureDelivery, finishCaptureDelivery } from "@workspace/db/capture-diagnostics";
import { accessHistoryPage } from "../src/lib/access-history";
import router from "../src/routes/clerk-events";

// Synthetic signing material only. The parent passes no real provider secrets.
const key = Buffer.from("private-capture-integration-fixture");
process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${key.toString("base64")}`;
process.env.CLERK_SECRET_KEY = process.env.CLERK_WEBHOOK_ENVIRONMENT === "production"
  ? "sk_live_fixture" : "sk_test_fixture";
const scope = {
  environment: process.env.CLERK_WEBHOOK_ENVIRONMENT as "development" | "production",
  instanceId: process.env.CLERK_WEBHOOK_INSTANCE_ID!,
};
const app = express();
app.use((req, _res, next) => {
  req.log = { warn: () => undefined } as unknown as typeof req.log;
  next();
});
app.use(router);

process.on("message", async (message: {
  action: string; requestId: number; attemptId?: string; succeeded?: boolean; variant?: string; eventId?: string;
}) => {
  try {
    let result: unknown;
    if (message.action === "read") {
      result = (await accessHistoryPage()).captureReadiness;
    } else if (message.action === "begin") {
      result = await beginCaptureDelivery(scope);
    } else if (message.action === "finish") {
      await finishCaptureDelivery(scope, message.attemptId!, message.succeeded!);
    } else if (message.action === "send") {
      const variant = message.variant;
      const eventId = message.eventId ?? `msg_fixture${message.requestId}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        type: variant === "ignored" ? "user.created" : "user.updated",
        timestamp: Date.now(),
        instance_id: variant === "instance" ? "ins_other" : scope.instanceId,
        data: variant === "malformed" ? {} : {
          id: "user_fixture", object: "user",
          public_metadata: { role: variant === "role" ? "unrecognized" : "admin" },
        },
      });
      const signature = createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64");
      const environment = variant === "environment" ? "production" : scope.environment;
      const response = await request(app).post(`/webhooks/clerk/${environment}`)
        .set("Content-Type", "application/json").set("svix-id", eventId)
        .set("svix-timestamp", timestamp)
        .set("svix-signature", variant === "signature" ? "v1,forged" : `v1,${signature}`)
        .send(body);
      result = response.status;
    } else {
      throw new Error("Unknown test action");
    }
    process.send?.({ requestId: message.requestId, result });
  } catch {
    process.send?.({ requestId: message.requestId, error: true });
  }
});
process.on("disconnect", () => { void pool.end().then(() => process.exit(0)); });
process.send?.({ ready: true });
