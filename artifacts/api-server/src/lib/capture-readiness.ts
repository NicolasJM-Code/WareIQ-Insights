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
let failure: { configuration: Configuration; at: string } | undefined;

export function noteCaptureDelivery(configuration: Configuration, succeeded: boolean) {
  if (succeeded) failure = undefined;
  else failure = { configuration, at: new Date().toISOString() };
}

export function captureReadiness(configuration: Configuration, lastVerifiedDeliveryAt: string | null) {
  const sameConfiguration = failure
    && failure.configuration.environment === configuration.environment
    && failure.configuration.instanceId === configuration.instanceId
    && failure.configuration.signingSecret === configuration.signingSecret;
  return {
    configuration: configuration.configured ? "configured" as const : "not_configured" as const,
    signing: configuration.signing ? "configured" as const : "not_configured" as const,
    routing: configuration.routing ? "configured" as const : "not_configured" as const,
    keyMode: configuration.keyMode ? "configured" as const : "not_configured" as const,
    environment: configuration.routing ? configuration.environment as "development" | "production" : null,
    delivery: !configuration.configured ? "not_configured" as const
      : sameConfiguration ? "delivery_problem" as const
      : lastVerifiedDeliveryAt ? "verified_delivery" as const : "unknown" as const,
    lastVerifiedDeliveryAt,
    lastDeliveryFailureAt: sameConfiguration ? failure!.at : null,
    failureScope: "current_process" as const,
  };
}
