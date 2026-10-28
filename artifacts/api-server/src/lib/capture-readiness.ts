// Shared with ingestion so readiness cannot disagree with its setup checks.
// Never return configuration values (especially signing material) to callers.
export function captureConfiguration() {
  const environment = process.env.CLERK_WEBHOOK_ENVIRONMENT;
  const instanceId = process.env.CLERK_WEBHOOK_INSTANCE_ID;
  const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  const signing = Boolean(signingSecret?.startsWith("whsec_") && signingSecret.length > 6);
  const routing = ["development", "production"].includes(environment ?? "")
    && /^ins_[A-Za-z0-9]+$/.test(instanceId ?? "");
  const keyMode = routing && Boolean(process.env.CLERK_SECRET_KEY?.startsWith(
    environment === "production" ? "sk_live_" : "sk_test_",
  ));
  return { environment, instanceId, signingSecret, signing, routing, keyMode,
    configured: signing && routing && keyMode };
}

type Configuration = ReturnType<typeof captureConfiguration>;
export type CaptureDiagnostic = {
  status: "pending" | "failed" | "succeeded";
  attemptedAt: Date;
} | null | "unavailable";

// A total storage outage can prevent even the pending marker from committing.
// Retain that authenticated failure in this process, scoped independently of
// signing-key rotation. This is not evidence of persistence across app restarts.
let attemptSequence = 0;
const processDeliveries = new Map<string, {
  sequence: number;
  failure: { status: "failed"; attemptedAt: Date } | null;
  failedAt: number;
}>();
function processScope(configuration: Configuration) {
  return JSON.stringify([configuration.environment, configuration.instanceId]);
}
export function beginProcessCaptureDelivery(configuration: Configuration) {
  const key = processScope(configuration);
  const sequence = ++attemptSequence;
  const attemptedAt = new Date();
  return (succeeded: boolean) => {
    const previous = processDeliveries.get(key);
    // A delayed completion must not erase a newer failure or restore an older
    // warning after a later delivery has succeeded.
    if (previous && previous.sequence > sequence) return;
    processDeliveries.set(key, {
      sequence, failure: succeeded ? null : { status: "failed", attemptedAt },
      failedAt: succeeded ? 0 : Date.now(),
    });
  };
}

export function captureReadiness(
  configuration: Configuration, lastVerifiedDeliveryAt: string | null, diagnostic: CaptureDiagnostic = null,
) {
  // A successful durable attempt that STARTED strictly after this failure was
  // reported proves recovery, including on another worker. A completion time
  // or historical evidence timestamp would let overlapping/old success hide it.
  // Equal timestamps are ambiguous, so keep the warning. This comparison relies
  // on synchronized application/database clocks and errs toward retaining it.
  if (diagnostic !== "unavailable") {
    const key = processScope(configuration);
    const local = processDeliveries.get(key);
    if (local?.failure) {
      if (diagnostic?.status === "succeeded" && diagnostic.attemptedAt.getTime() > local.failedAt) {
        // Keep a sequence fence so a delayed local completion cannot restore a
        // warning superseded by the confirmed cross-worker recovery.
        processDeliveries.set(key, { sequence: ++attemptSequence, failure: null, failedAt: 0 });
      } else {
        diagnostic = local.failure;
      }
    }
  }
  return {
    configuration: configuration.configured ? "configured" as const : "not_configured" as const,
    signing: configuration.signing ? "configured" as const : "not_configured" as const,
    routing: configuration.routing ? "configured" as const : "not_configured" as const,
    keyMode: configuration.keyMode ? "configured" as const : "not_configured" as const,
    environment: configuration.routing ? configuration.environment as "development" | "production" : null,
    delivery: !configuration.configured ? "not_configured" as const
      : diagnostic === "unavailable" ? "diagnostics_unavailable" as const
      : diagnostic?.status === "failed" ? "delivery_problem" as const
      : diagnostic?.status === "pending" ? "delivery_unknown" as const
      : lastVerifiedDeliveryAt ? "verified_delivery" as const : "unknown" as const,
    lastVerifiedDeliveryAt,
    lastDeliveryFailureAt: diagnostic !== "unavailable" && diagnostic?.status === "failed"
      ? diagnostic.attemptedAt.toISOString() : null,
    failureScope: "environment_instance" as const,
  };
}
