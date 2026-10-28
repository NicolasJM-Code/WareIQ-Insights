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
const processDeliveries = new Map<string, { sequence: number; failure: CaptureDiagnostic }>();
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
    });
  };
}

export function captureReadiness(
  configuration: Configuration, lastVerifiedDeliveryAt: string | null, diagnostic: CaptureDiagnostic = null,
) {
  // Historical durable success cannot disprove a later failure which storage
  // was unable to record. Only a subsequent completed delivery clears it here.
  if (diagnostic !== "unavailable") {
    diagnostic = processDeliveries.get(processScope(configuration))?.failure ?? diagnostic;
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
