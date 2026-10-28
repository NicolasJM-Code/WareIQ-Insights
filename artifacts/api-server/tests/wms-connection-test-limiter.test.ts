import { describe, expect, test } from "vitest";
import { WmsConnectionTestLimiter } from "../src/lib/wms-connection-test-limiter";

describe("WmsConnectionTestLimiter", () => {
  test("allows parallel sites while limiting duplicate checks for one site", () => {
    const limiter = new WmsConnectionTestLimiter();
    const first = limiter.acquire("client-a/site-a", "connection", 1_000);
    expect(first).toBeTypeOf("function");
    expect(limiter.acquire("client-a/site-a", "connection", 1_001)).toBeUndefined();
    const second = limiter.acquire("client-a/site-b", "connection", 1_001);
    expect(second).toBeTypeOf("function");
    first?.();
    expect(limiter.acquire("client-a/site-a", "connection", 1_002)).toBeUndefined();
    second?.();
    const vpn = limiter.acquire("client-a/site-a", "vpn", 1_002);
    expect(vpn).toBeTypeOf("function");
    vpn?.();
    expect(limiter.acquire("client-a/site-a", "connection", 11_000)).toBeTypeOf("function");
  });

  test("caps retained site entries and aggregate active checks", () => {
    const limiter = new WmsConnectionTestLimiter();
    const leases = Array.from({ length: 8 }, (_, index) =>
      limiter.acquire(`client/site-${index}`, "connection", 1_000));
    expect(leases.every(Boolean)).toBe(true);
    expect(limiter.acquire("client/site-overflow", "connection", 1_000)).toBeUndefined();
    leases.forEach((release) => release?.());

    const rateLimiter = new WmsConnectionTestLimiter();
    for (let index = 0; index < 20; index += 1) {
      const release = rateLimiter.acquire(`client/rate-${index}`, "connection", 1_000);
      expect(release).toBeTypeOf("function");
      release?.();
    }
    expect(rateLimiter.acquire("client/rate-overflow", "connection", 1_000)).toBeUndefined();
    expect(rateLimiter.acquire("client/rate-after-window", "connection", 11_000)).toBeTypeOf("function");

    const capacityLimiter = new WmsConnectionTestLimiter({ maxSiteEntries: 3 });
    const entryLeases = Array.from({ length: 3 }, (_, index) =>
      capacityLimiter.acquire(`client/site-${index}`, "connection", 1_000));
    expect(entryLeases.every(Boolean)).toBe(true);
    entryLeases.forEach((release) => release?.());
    expect(capacityLimiter.acquire("client/site-overflow", "connection", 1_001)).toBeUndefined();
    expect(capacityLimiter.acquire("client/site-after-expiry", "connection", 11_000)).toBeTypeOf("function");
  });
});
