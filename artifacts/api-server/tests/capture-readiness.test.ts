import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureConfiguration, captureReadiness } from "../src/lib/capture-readiness";

beforeEach(() => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_isolated");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_isolated");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
});
afterEach(() => vi.unstubAllEnvs());

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
