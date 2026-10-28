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

export function captureReadiness(
  configuration: Configuration, lastVerifiedDeliveryAt: string | null, diagnostic: CaptureDiagnostic = null,
) {
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
