import assert from "node:assert/strict";
import test from "node:test";
import {
  WmsConnectionTestLimiter,
  type WmsConnectionTestLimiterState,
  type WmsConnectionTestLimiterStore,
} from "./wms-connection-test-limiter";

class SharedTestStore implements WmsConnectionTestLimiterStore {
  state: WmsConnectionTestLimiterState = { sites: {}, starts: [] };
  unavailable = false;
  private tail: Promise<void> = Promise.resolve();

  async withLockedState<T>(
    operation: (state: WmsConnectionTestLimiterState, now: number) => T,
  ): Promise<T> {
    if (this.unavailable) throw new Error("storage unavailable");
    let unlock!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      if (this.unavailable) throw new Error("storage unavailable");
      return operation(this.state, Date.now());
    } finally {
      unlock();
    }
  }
}

test("separate limiter instances share per-site cooldown and active state", async () => {
  const store = new SharedTestStore();
  const firstWorker = new WmsConnectionTestLimiter(store);
  const secondWorker = new WmsConnectionTestLimiter(store);

  const release = await firstWorker.acquire("client-a/site-a", "connection");
  assert.ok(release);
  assert.equal(await secondWorker.acquire("client-a/site-a", "vpn"), undefined);
  await release();
  assert.equal(await secondWorker.acquire("client-a/site-a", "connection"), undefined);
  assert.ok(await secondWorker.acquire("client-a/site-a", "vpn"));
});

test("concurrent instances enforce the aggregate active-check ceiling", async () => {
  const store = new SharedTestStore();
  const firstWorker = new WmsConnectionTestLimiter(store, { maxActiveTests: 1 });
  const secondWorker = new WmsConnectionTestLimiter(store, { maxActiveTests: 1 });

  const [first, second] = await Promise.all([
    firstWorker.acquire("client-a/site-a", "connection"),
    secondWorker.acquire("client-b/site-b", "connection"),
  ]);
  assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1);
});

test("concurrent instances enforce the aggregate rolling start ceiling", async () => {
  const store = new SharedTestStore();
  const firstWorker = new WmsConnectionTestLimiter(store, { maxTestStartsPerWindow: 1 });
  const secondWorker = new WmsConnectionTestLimiter(store, { maxTestStartsPerWindow: 1 });

  const [first, second] = await Promise.all([
    firstWorker.acquire("client-a/site-a", "connection"),
    secondWorker.acquire("client-b/site-b", "vpn"),
  ]);
  assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1);
});

test("storage outages reject acquisition instead of using process-local state", async () => {
  const store = new SharedTestStore();
  const firstWorker = new WmsConnectionTestLimiter(store);
  const secondWorker = new WmsConnectionTestLimiter(store);
  store.unavailable = true;

  await assert.rejects(firstWorker.acquire("client-a/site-a", "connection"), /storage unavailable/);
  await assert.rejects(secondWorker.acquire("client-a/site-a", "connection"), /storage unavailable/);
});
