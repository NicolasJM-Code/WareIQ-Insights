import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { PrivateDatabase } from "./database";

const database = new PrivateDatabase();
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");
const children: ChildProcess[] = [];
let requestId = 0;

async function replica(environment = "development", instanceId = "ins_fixture") {
  const child = fork(fileURLToPath(new URL("./capture-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", tsx],
    env: {
      NODE_ENV: "test", DATABASE_URL: database.connectionString,
      CLERK_WEBHOOK_ENVIRONMENT: environment, CLERK_WEBHOOK_INSTANCE_ID: instanceId,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("exit", () => reject(new Error("Capture worker exited before ready")));
  });
  return {
    child,
    async call<T = unknown>(action: string, args: object = {}): Promise<T> {
      const id = ++requestId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("Capture worker timed out")); }, 8_000);
        const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); };
        const exit = () => { cleanup(); reject(new Error("Capture worker exited during request")); };
        const receive = (message: { requestId: number; error?: boolean; result: T }) => {
          if (message.requestId !== id) return;
          cleanup();
          if (message.error) reject(new Error("Capture worker operation failed"));
          else resolve(message.result);
        };
        child.on("message", receive);
        child.once("exit", exit);
        child.send({ action, requestId: id, ...args });
      });
    },
  };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}

beforeAll(() => database.start());
beforeEach(async () => {
  await database.pool.query("TRUNCATE access_change_history, capture_delivery_diagnostics");
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(kill));
  await database.pool.query("DROP TRIGGER IF EXISTS reject_capture ON access_change_history");
});
afterAll(() => database.stop());

it("retains an authenticated storage failure across process death and shares recovery with live replicas", async () => {
  const writer = await replica();
  const reader = await replica();
  expect(await writer.call("send")).toBe(204);
  await database.pool.query(`
    CREATE OR REPLACE FUNCTION reject_capture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic evidence failure'; END $$;
    CREATE TRIGGER reject_capture BEFORE INSERT ON access_change_history
      FOR EACH ROW EXECUTE FUNCTION reject_capture()`);
  expect(await writer.call("send")).toBe(503);
  const failed = await reader.call("read");
  expect(failed).toMatchObject({
    delivery: "delivery_problem", lastDeliveryFailureAt: expect.any(String),
    lastVerifiedDeliveryAt: expect.any(String), failureScope: "environment_instance",
  });
  await kill(writer.child);
  const restarted = await replica();
  expect(await restarted.call("read")).toEqual(failed);
  // Real signature verifier + database: rejected/ignored deliveries neither
  // create diagnostics nor clear an existing warning on any replica.
  for (const variant of ["signature", "instance", "environment", "ignored", "role", "malformed"]) {
    await restarted.call("send", { variant });
    expect(await reader.call("read")).toEqual(failed);
  }
  await database.pool.query("DROP TRIGGER reject_capture ON access_change_history");
  expect(await restarted.call("send")).toBe(204);
  expect(await reader.call("read")).toMatchObject({
    delivery: "verified_delivery", lastDeliveryFailureAt: null, lastVerifiedDeliveryAt: expect.any(String),
  });
  const rows = await database.pool.query("SELECT * FROM capture_delivery_diagnostics");
  expect(Object.keys(rows.rows[0]).sort()).toEqual(["attempt_id", "attempted_at", "environment", "instance_id", "status"]);
  expect(rows.rowCount).toBe(1);
});

it("isolates environment and instance, including invalid deliveries before any diagnostics exist", async () => {
  const writer = await replica();
  for (const variant of ["signature", "instance", "environment", "ignored", "role", "malformed"]) {
    await writer.call("send", { variant });
  }
  expect((await database.pool.query("SELECT * FROM capture_delivery_diagnostics")).rowCount).toBe(0);
  const attemptId = await writer.call<string>("begin");
  await writer.call("finish", { attemptId, succeeded: false });
  for (const [environment, instance] of [["production", "ins_fixture"], ["development", "ins_another"]]) {
    const other = await replica(environment, instance);
    expect(await other.call("read")).toMatchObject({ delivery: "unknown", lastDeliveryFailureAt: null });
  }
  expect(await writer.call("read")).toMatchObject({ delivery: "delivery_problem" });
});

it("preserves interrupted attempts on restart and prevents older replicas overwriting newer outcomes", async () => {
  const first = await replica();
  const second = await replica();
  const older = await first.call<string>("begin");
  await kill(first.child);
  const restarted = await replica();
  expect(await restarted.call("read")).toMatchObject({ delivery: "delivery_unknown", lastDeliveryFailureAt: null });
  const newer = await second.call<string>("begin");
  await second.call("finish", { attemptId: newer, succeeded: false });
  const failed = await second.call("read");
  await restarted.call("finish", { attemptId: older, succeeded: true });
  expect(await second.call("read")).toEqual(failed);
  expect(await restarted.call("send")).toBe(204);
  await second.call("finish", { attemptId: newer, succeeded: false });
  expect(await restarted.call("read")).toMatchObject({ delivery: "verified_delivery" });
});
