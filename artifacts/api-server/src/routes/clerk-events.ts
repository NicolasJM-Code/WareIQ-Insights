import { Router, raw, type ErrorRequestHandler, type IRouter } from "express";
import { verifyWebhook } from "@clerk/express/webhooks";
import { recordProviderRoleObservation } from "@workspace/db/access-audit";
import { beginProcessCaptureDelivery, captureConfiguration } from "../lib/capture-readiness";
import { beginCaptureDelivery, finishCaptureDelivery } from "@workspace/db/capture-diagnostics";

const router: IRouter = Router();

// This is the ONLY non-cookie mutation route: mount before Clerk session/CSRF
// middleware and JSON parsing. Its authentication is the raw-body signature.
router.post("/webhooks/clerk/:environment", raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const configuration = captureConfiguration();
  const { environment, instanceId, signingSecret } = configuration;
  if (!configuration.configured) {
    res.status(503).json({ error: "Provider event capture is not configured." });
    return;
  }
  if (req.params.environment !== environment) {
    res.status(403).json({ error: "Provider event environment mismatch." });
    return;
  }
  const eventId = req.get("svix-id");
  if (!Buffer.isBuffer(req.body) || !/^msg_[A-Za-z0-9]{1,200}$/.test(eventId ?? "")) {
    res.status(400).json({ error: "Invalid provider event." });
    return;
  }
  let event;
  try {
    // SDK verifies HMAC in constant time and enforces delivery timestamp
    // tolerance. Never log the event, signature, secret, or verification error.
    event = await verifyWebhook(req, { signingSecret });
  } catch {
    res.status(400).json({ error: "Invalid provider event signature." });
    return;
  }
  if (event.instance_id !== instanceId) {
    res.status(403).json({ error: "Provider event instance mismatch." });
    return;
  }
  // A user update is a role snapshot, NOT proof of a role transition or actor.
  // Do not retain arbitrary event attributes or metadata, even when signed.
  if (event.type !== "user.updated") {
    res.sendStatus(204);
    return;
  }
  const data = event.data;
  if (!data || data.object !== "user" || !/^user_[A-Za-z0-9]{1,200}$/.test(data.id ?? "")
    || !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0
    || event.timestamp > Date.now() + 300_000
    || !data.public_metadata || typeof data.public_metadata !== "object"
    || Array.isArray(data.public_metadata)) {
    res.status(400).json({ error: "Invalid provider role evidence." });
    return;
  }
  const role = data.public_metadata.role;
  // Missing/null role means no platform role. Other values are not allowlisted
  // evidence and must not be relabelled as a recognized application role.
  if (role != null && role !== "admin" && role !== "supervisor" && role !== "unassigned") {
    res.sendStatus(204);
    return;
  }
  const scope = { environment: environment as "development" | "production", instanceId: instanceId! };
  const finishProcessDelivery = beginProcessCaptureDelivery(configuration);
  let attemptId: string | undefined;
  try {
    attemptId = await beginCaptureDelivery(scope);
    await recordProviderRoleObservation({
      eventId: eventId!, instanceId: instanceId!,
      environment: environment as "development" | "production",
      occurredAt: new Date(event.timestamp), targetId: data.id,
      role: role == null ? "unassigned" : role,
    });
    await finishCaptureDelivery(scope, attemptId, true);
    finishProcessDelivery(true);
    res.sendStatus(204);
  } catch {
    finishProcessDelivery(false);
    // If the database is unavailable the committed pending marker survives.
    // Do not let a failed diagnostics write acknowledge the provider delivery.
    if (attemptId) await finishCaptureDelivery(scope, attemptId, false).catch(() => undefined);
    req.log.warn({ code: "provider_evidence_write_failed" }, "Provider role evidence could not be saved");
    // Do not acknowledge on storage failure: allow the provider to retry.
    res.status(503).json({ error: "Provider role evidence could not be saved." });
  }
});

// Body-parser errors must not turn oversized event bodies into an endless
// retryable 500, or log any fragment of the request.
router.use(((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    res.status(413).json({ error: "Provider event is too large." });
    return;
  }
  next(error);
}) as ErrorRequestHandler);

export default router;
