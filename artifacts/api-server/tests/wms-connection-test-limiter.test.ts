import { describe, expect, test } from "vitest";
import {
  WmsConnectionTestLimiter,
  type WmsConnectionTestLimiterState,
  type WmsConnectionTestLimiterStore,
} from "../src/lib/wms-connection-test-limiter";

class TestStore implements WmsConnectionTestLimiterStore {
  state: WmsConnectionTestLimiterState = { sites: {}, starts: [] };
  now = 1_000;

  async withLockedState<T>(
    operation: (state: WmsConnectionTestLimiterState, now: number) => T,
  ): Promise<T> {
    return operation(this.state, this.now);
  }
}

describe("WmsConnectionTestLimiter", () => {
  test("allows parallel sites while limiting duplicate checks for one site", async () => {
    const store = new TestStore();
    const limiter = new WmsConnectionTestLimiter(store);
    const first = await limiter.acquire("client-a/site-a", "connection");
    expect(first).toBeTypeOf("function");
    expect(await limiter.acquire("client-a/site-a", "connection")).toBeUndefined();
    const second = await limiter.acquire("client-a/site-b", "connection");
    expect(second).toBeTypeOf("function");
    await first?.();
    expect(await limiter.acquire("client-a/site-a", "connection")).toBeUndefined();
    await second?.();
    const vpn = await limiter.acquire("client-a/site-a", "vpn");
    expect(vpn).toBeTypeOf("function");
    await vpn?.();
    store.now = 11_000;
    expect(await limiter.acquire("client-a/site-a", "connection")).toBeTypeOf("function");
  });

  test("caps retained site entries and aggregate active checks", async () => {
    const limiter = new WmsConnectionTestLimiter(new TestStore());
    const leases = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      limiter.acquire(`client/site-${index}`, "connection")));
    expect(leases.every(Boolean)).toBe(true);
    expect(await limiter.acquire("client/site-overflow", "connection")).toBeUndefined();
    await Promise.all(leases.map((release) => release?.()));

    const rateStore = new TestStore();
    const rateLimiter = new WmsConnectionTestLimiter(rateStore);
    for (let index = 0; index < 20; index += 1) {
      const release = await rateLimiter.acquire(`client/rate-${index}`, "connection");
      expect(release).toBeTypeOf("function");
      await release?.();
    }
    expect(await rateLimiter.acquire("client/rate-overflow", "connection")).toBeUndefined();
    rateStore.now = 11_000;
    expect(await rateLimiter.acquire("client/rate-after-window", "connection")).toBeTypeOf("function");

    const capacityStore = new TestStore();
    const capacityLimiter = new WmsConnectionTestLimiter(capacityStore, { maxSiteEntries: 3 });
    const entryLeases = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      capacityLimiter.acquire(`client/site-${index}`, "connection")));
    expect(entryLeases.every(Boolean)).toBe(true);
    await Promise.all(entryLeases.map((release) => release?.()));
    expect(await capacityLimiter.acquire("client/site-overflow", "connection")).toBeUndefined();
    capacityStore.now = 11_000;
    expect(await capacityLimiter.acquire("client/site-after-expiry", "connection")).toBeTypeOf("function");
  });
});
