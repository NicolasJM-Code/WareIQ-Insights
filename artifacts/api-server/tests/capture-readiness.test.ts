import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginProcessCaptureDelivery, captureConfiguration, captureReadiness } from "../src/lib/capture-readiness";

beforeEach(() => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_isolated");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_isolated");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it("reports configured but unknown with no delivery, regardless of elapsed time", () => {
  const configuration = captureConfiguration();
  expect(captureReadiness(configuration, null)).toMatchObject({ configuration: "configured", delivery: "unknown" });
  expect(captureReadiness(configuration, "2020-01-01T00:00:00.000Z").delivery).toBe("verified_delivery");
  expect(JSON.stringify(captureReadiness(configuration, null))).not.toMatch(/whsec|sk_test|ins_isolated/);
});
it.each([
  ["CLERK_WEBHOOK_SIGNING_SECRET", "", "signing"],
  ["CLERK_WEBHOOK_SIGNING_SECRET", "whsec_", "signing"],
  ["CLERK_WEBHOOK_ENVIRONMENT", "staging", "routing"],
  ["CLERK_WEBHOOK_INSTANCE_ID", "user_wrong", "routing"],
  ["CLERK_SECRET_KEY", "sk_live_wrong", "keyMode"],
])("fails closed for missing or invalid %s", (name, value, field) => {
  vi.stubEnv(name, value);
  expect(captureReadiness(captureConfiguration(), null)).toMatchObject({
    configuration: "not_configured", delivery: "not_configured", [field]: "not_configured",
  });
});
it("accepts only a matching production setup", () => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "production");
  expect(captureConfiguration().configured).toBe(false);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_live_isolated");
  expect(captureReadiness(captureConfiguration(), null)).toMatchObject({
    configuration: "configured", environment: "production", delivery: "unknown",
  });
});
it("keeps durable failures, interrupted attempts and unavailable diagnostics distinct from historical success", () => {
  const configuration = captureConfiguration();
  const attemptedAt = new Date("2026-10-27T12:00:00.000Z");
  expect(captureReadiness(configuration, "2020-01-01T00:00:00.000Z", { status: "failed", attemptedAt })).toMatchObject({
    delivery: "delivery_problem", lastDeliveryFailureAt: attemptedAt.toISOString(), failureScope: "environment_instance",
  });
  expect(captureReadiness(configuration, null, { status: "pending", attemptedAt }).delivery).toBe("delivery_unknown");
  expect(captureReadiness(configuration, "2020-01-01T00:00:00.000Z", "unavailable").delivery).toBe("diagnostics_unavailable");
  expect(captureReadiness(configuration, null, { status: "succeeded", attemptedAt }).lastDeliveryFailureAt).toBeNull();
});

it("retains outage failures through key rotation without leaking them to other instances", () => {
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_processScope");
  const configuration = captureConfiguration();
  const finish = beginProcessCaptureDelivery(configuration);
  finish(false);
  const failure = captureReadiness(configuration, "2020-01-01T00:00:00.000Z");
  expect(failure.delivery).toBe("delivery_problem");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_rotated");
  expect(captureReadiness(captureConfiguration(), failure.lastVerifiedDeliveryAt)).toEqual(failure);
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_otherProcessScope");
  expect(captureReadiness(captureConfiguration(), null).delivery).toBe("unknown");
  beginProcessCaptureDelivery(configuration)(true);
  expect(captureReadiness(configuration, failure.lastVerifiedDeliveryAt).delivery).toBe("verified_delivery");
});

it("does not let delayed earlier completions replace a newer process delivery outcome", () => {
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_processOrder");
  const configuration = captureConfiguration();
  const earlierSuccess = beginProcessCaptureDelivery(configuration);
  const laterFailure = beginProcessCaptureDelivery(configuration);
  laterFailure(false);
  const warning = captureReadiness(configuration, "2020-01-01T00:00:00.000Z");
  earlierSuccess(true);
  expect(captureReadiness(configuration, warning.lastVerifiedDeliveryAt)).toEqual(warning);
  const earlierFailure = beginProcessCaptureDelivery(configuration);
  beginProcessCaptureDelivery(configuration)(true);
  earlierFailure(false);
  expect(captureReadiness(configuration, warning.lastVerifiedDeliveryAt)).toMatchObject({
    delivery: "verified_delivery", lastDeliveryFailureAt: null,
  });
});

it("requires a strictly newer successful attempt and preserves the failure time until then", () => {
  vi.useFakeTimers();
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_remoteRecovery");
  const configuration = captureConfiguration();
  const start = new Date("2026-10-28T10:00:00.000Z");
  vi.setSystemTime(start);
  const finish = beginProcessCaptureDelivery(configuration);
  vi.setSystemTime(new Date(start.getTime() + 1_000));
  finish(false);
  const warning = captureReadiness(configuration, start.toISOString());
  expect(warning.lastDeliveryFailureAt).toBe(start.toISOString());
  // Even an attempt newer than the failed attempt's start is not recovery if
  // it began before the local failure completed.
  for (const offset of [-1, 500, 1_000]) {
    expect(captureReadiness(configuration, start.toISOString(), {
      status: "succeeded", attemptedAt: new Date(start.getTime() + offset),
    })).toEqual(warning);
  }
  const newer = new Date(start.getTime() + 2_000);
  for (const status of ["pending", "failed"] as const) {
    expect(captureReadiness(configuration, start.toISOString(), { status, attemptedAt: newer })).toEqual(warning);
  }
  expect(captureReadiness(configuration, start.toISOString(), "unavailable").delivery).toBe("diagnostics_unavailable");
  expect(captureReadiness(configuration, start.toISOString())).toEqual(warning);
  const delayedFailure = beginProcessCaptureDelivery(configuration);
  const recovered = captureReadiness(configuration, newer.toISOString(), { status: "succeeded", attemptedAt: newer });
  expect(recovered).toMatchObject({ delivery: "verified_delivery", lastDeliveryFailureAt: null });
  delayedFailure(false);
  expect(captureReadiness(configuration, newer.toISOString())).toEqual(recovered);
});
