import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { PrivateDatabase } from "./database";

type Message = {
  event?: string; requestId?: number; error?: boolean;
  sends?: number; key?: string; result?: unknown;
};
const database = new PrivateDatabase();
const children: ChildProcess[] = [];
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");

function launch(fault = "") {
  const child = fork(fileURLToPath(new URL("./notification-disconnect-worker.ts", import.meta.url)), [fault], {
    execArgv: ["--import", tsx],
    // No inherited PG defaults, application credentials, or WMS access.
    env: { NODE_ENV: "test", DATABASE_URL: database.connectionString },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const messages: Message[] = [];
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.on("message", (message) => { messages.push(message as Message); });
  let requestId = 0;
  const wait = async (predicate: (message: Message) => boolean) => {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Notification process exited (${child.exitCode}/${child.signalCode}): ${stderr}`);
      }
      return messages.some(predicate);
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    const message = messages.find(predicate)!;
    expect(message.error).not.toBe(true);
    return message;
  };
  return {
    child, messages, wait,
    output: () => stdout,
    ready: () => wait((message) => message.event === "ready"),
    request(action: string) {
      const id = ++requestId;
      child.send({ action, requestId: id });
      return { id, response: () => wait((message) => message.requestId === id) };
    },
  };
}

async function storedNotice() {
  return (await database.pool.query(`
    SELECT id, state, attempts, first_attempt_at, next_attempt_at
    FROM wareiq_access_notifications WHERE id = 'disconnect-notice'
  `)).rows[0];
}

beforeAll(() => database.start());
beforeEach(async () => {
  await database.pool.query("TRUNCATE wareiq_access_notifications");
  await database.pool.query(`
    INSERT INTO wareiq_access_notifications
      (id, recipient, role_name, kind, target_id, platform_role, state, next_attempt_at)
    VALUES ('disconnect-notice', 'synthetic@example.test', 'Supervisor', 'platform',
      'synthetic-user', 'supervisor', 'pending', now())
  `);
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exit;
  }));
});
afterAll(() => database.stop());

it("confirms provider acceptance when the role lock remains connected", async () => {
  const worker = launch();
  await worker.ready();
  const delivery = worker.request("deliver");
  await worker.wait((message) => message.event === "dispatch");
  worker.child.send({ action: "resume" });
  expect((await delivery.response()).result).toEqual({ sends: 1 });
  expect(await storedNotice()).toMatchObject({ state: "sent", attempts: 1 });
  expect((await worker.request("read").response()).result).toMatchObject({
    summary: { accepted: 1, uncertain: 0, failed: 0 },
    uncertain: [],
  });
});

it.each(["accepted", "transport-error"])(
  "survives role-lock loss during %s delivery without inventing success or sending twice",
  async (fault) => {
    const worker = launch(fault);
    await worker.ready();
    const delivery = worker.request("deliver");
    expect(await worker.wait((message) => message.event === "dispatch")).toMatchObject({
      sends: 1, key: "wareiq-access/disconnect-notice",
    });
    const intent = await storedNotice();
    expect(intent).toMatchObject({ state: "pending", attempts: 1, first_attempt_at: expect.any(Date) });

    // Kill exactly the production role-lock backend, not the separate outbox
    // connection. Provider IO is paused between queries, exercising async errors.
    const killed = await database.pool.query(`
      SELECT pg_terminate_backend(pid) AS killed FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 174983 AND objid = 1 AND granted
    `);
    expect(killed.rows).toEqual([{ killed: true }]);
    expect((await database.pool.query("SHOW listen_addresses")).rows[0]).toEqual({ listen_addresses: "" });
    expect((await worker.request("available").response()).result).toEqual({ available: 1 });
    expect(worker.messages.some((message) => message.requestId === delivery.id)).toBe(false);
    expect(await storedNotice()).toEqual(intent);

    worker.child.send({ action: "resume" });
    expect((await delivery.response()).result).toEqual({ sends: 1 });
    await expect.poll(worker.output).toContain("access_notification_delivery_failed");
    expect(await storedNotice()).toEqual(intent);
    expect((await worker.request("available").response()).result).toEqual({ available: 1 });
    // The scheduled retry must not dispatch again immediately.
    expect((await worker.request("deliver").response()).result).toEqual({ sends: 1 });

    // After the provider deduplication window, retain explicit uncertainty
    // instead of risking a second send. Read it through a fresh app process.
    await database.pool.query(`
      UPDATE wareiq_access_notifications SET
        first_attempt_at = now() - interval '24 hours', next_attempt_at = now()
      WHERE id = 'disconnect-notice'
    `);
    expect((await worker.request("deliver").response()).result).toEqual({ sends: 1 });
    expect(await storedNotice()).toMatchObject({ state: "failed", attempts: 1 });
    const reader = launch();
    await reader.ready();
    expect((await reader.request("read").response()).result).toMatchObject({
      summary: { queued: 0, accepted: 0, failed: 0, uncertain: 1, retrying: 0 },
      uncertain: [{ id: "disconnect-notice", attempts: 1 }],
    });
    expect((await reader.request("deliver").response()).result).toEqual({ sends: 0 });
    expect(worker.messages.filter((message) => message.event === "dispatch")).toHaveLength(1);
  },
);
