import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureConfiguration, captureReadiness, noteCaptureDelivery } from "../src/lib/capture-readiness";

beforeEach(() => {
  vi.stubEnv("CLERK_WEBHOOK_ENVIRONMENT", "development");
  vi.stubEnv("CLERK_WEBHOOK_INSTANCE_ID", "ins_isolated");
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_isolated");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_isolated");
  noteCaptureDelivery(captureConfiguration(), true);
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
it("keeps authenticated write failure visible over old evidence until a successful delivery", () => {
  const configuration = captureConfiguration();
  noteCaptureDelivery(configuration, false);
  expect(captureReadiness(configuration, "2020-01-01T00:00:00.000Z")).toMatchObject({
    delivery: "delivery_problem", lastDeliveryFailureAt: expect.any(String), failureScope: "current_process",
  });
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_rotated");
  expect(captureReadiness(captureConfiguration(), null).delivery).toBe("unknown");
  noteCaptureDelivery(configuration, true);
  expect(captureReadiness(configuration, null).lastDeliveryFailureAt).toBeNull();
});
