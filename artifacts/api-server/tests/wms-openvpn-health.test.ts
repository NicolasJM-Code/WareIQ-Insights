import { afterEach, expect, test, vi } from "vitest";
import { advanceVpnHealth, initialVpnHealth, singleFlightMonitor } from "../src/lib/wms-vpn-health";
import { notificationMessage } from "../src/lib/access-notification-message";

afterEach(() => vi.useRealTimers());
const now = "2026-10-28T12:00:00.000Z";

test("a transient failure sends no notice; sustained failures and recovery are deduplicated", () => {
  let state = initialVpnHealth();
  const step = (observation: "healthy" | "unavailable" | "unknown") => {
    const result = advanceVpnHealth(state, observation, now, "outage-fixture");
    state = result.state;
    return result.notice;
  };
  expect(step("unavailable")).toBeNull();
  expect(step("healthy")).toBeNull();
  expect(step("unavailable")).toBeNull();
  expect(step("unavailable")).toBe("vpn_outage");
  for (let i = 0; i < 20; i++) expect(step("unavailable")).toBeNull();
  expect(state.failures).toBe(2);
  expect(step("unknown")).toBeNull();
  expect(state.outageId).toBe("outage-fixture");
  expect(step("unavailable")).toBeNull();
  expect(step("healthy")).toBe("vpn_recovery");
  expect(step("healthy")).toBeNull();
  expect(state.outageId).toBeNull();
  expect(step("unavailable")).toBeNull();
  expect(step("unknown")).toBeNull();
  expect(step("unavailable")).toBeNull();
  expect(step("unavailable")).toBe("vpn_outage");
});

test("a timed out monitor reports unknown and never overlaps unresolved work", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const unknown = vi.fn();
  const tick = singleFlightMonitor(work, unknown, 100);
  const running = tick();
  await tick();
  expect(work).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(unknown).toHaveBeenCalledTimes(1);
  await tick();
  expect(work).toHaveBeenCalledTimes(1);
  finish();
  await running;
  const next = tick();
  expect(work).toHaveBeenCalledTimes(2);
  finish();
  await next;
  expect(vi.getTimerCount()).toBe(0);
});

test("unexpected monitor errors are reported without leaking error contents", async () => {
  const unknown = vi.fn();
  await singleFlightMonitor(async () => { throw new Error("secret-fixture"); }, unknown)();
  expect(unknown).toHaveBeenCalledExactlyOnceWith();
});

test("VPN email messages are distinct and never interpolate configuration or roles", () => {
  const outage = notificationMessage("vpn_outage", "secret-fixture");
  const recovery = notificationMessage("vpn_recovery", "secret-fixture");
  expect(outage.subject).toContain("unavailable");
  expect(recovery.subject).toContain("recovered");
  expect(JSON.stringify([outage, recovery])).not.toContain("secret-fixture");
  expect(recovery.text).toContain("does not verify SQL");
});
