import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { PrivateDatabase } from "./database";

type Summary = {
  queued: number;
  queuedOverThreshold: number;
  oldestQueuedAgeSeconds: number | null;
  queueWarningAfterSeconds: number;
  retrying: number;
  accepted: number;
  failed: number;
  uncertain: number;
};
type WorkerMessage = { event: "ready" } | { event: "summary"; summary?: Summary; error?: boolean };

const database = new PrivateDatabase();
const children: ChildProcess[] = [];
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");

async function launchSummaryWorker() {
  const child = fork(fileURLToPath(new URL("./notifications-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", tsx],
    env: { NODE_ENV: "test", DATABASE_URL: database.connectionString },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const waitFor = (event: WorkerMessage["event"]) => new Promise<WorkerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", receive);
      reject(new Error(`Notification worker timed out waiting for ${event}: ${stderr}`));
    }, 10_000);
    const receive = (message: WorkerMessage) => {
      if (message.event !== event) return;
      clearTimeout(timeout);
      child.off("message", receive);
      resolve(message);
    };
    child.on("message", receive);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      child.off("message", receive);
      reject(new Error(`Notification worker exited before ${event} (${code}): ${stderr}`));
    });
  });
  await waitFor("ready");
  return {
    child,
    async summary() {
      const response = waitFor("summary");
      child.send({ action: "summary" });
      const message = await response;
      if (message.event !== "summary" || message.error || !message.summary) {
        throw new Error("Notification summary query failed");
      }
      return message.summary;
    },
  };
}

beforeAll(() => database.start());
beforeEach(async () => {
  await database.pool.query("TRUNCATE access_change_history, capture_delivery_diagnostics, wareiq_access_notifications");
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

it("counts only never-attempted notices and warns at the five-minute boundary", async () => {
  const worker = await launchSummaryWorker();
  await database.pool.query(`
    INSERT INTO wareiq_access_notifications (id, recipient, role_name, kind, state, attempts, created_at)
    VALUES
      ('old-pending', 'old-pending@example.test', 'Supervisor', 'reporting', 'pending', 0, now() - interval '301 seconds'),
      ('threshold-confirming', 'threshold@example.test', 'Supervisor', 'platform', 'confirming', 0, now() - interval '300 seconds'),
      ('recent-pending', 'recent@example.test', 'Supervisor', 'reporting', 'pending', 0, now() - interval '295 seconds'),
      ('attempted-confirming', 'attempted-confirming@example.test', 'Supervisor', 'platform', 'confirming', 1, now() - interval '1 hour'),
      ('retrying-pending', 'retrying@example.test', 'Supervisor', 'reporting', 'pending', 2, now() - interval '1 hour'),
      ('sent-terminal', 'sent@example.test', 'Supervisor', 'reporting', 'sent', 0, now() - interval '1 hour'),
      ('failed-terminal', 'failed@example.test', 'Supervisor', 'reporting', 'failed', 0, now() - interval '1 hour'),
      ('confirmed-failed-terminal', 'confirmed-failed@example.test', 'Supervisor', 'reporting', 'confirmed_failed', 0, now() - interval '1 hour'),
      ('cancelled-terminal', 'cancelled@example.test', 'Supervisor', 'reporting', 'cancelled', 0, now() - interval '1 hour')`);

  const summary = await worker.summary();
  expect(summary).toMatchObject({
    queued: 3,
    queuedOverThreshold: 2,
    queueWarningAfterSeconds: 300,
    retrying: 1,
    accepted: 1,
    failed: 1,
    uncertain: 1,
  });
  expect(summary.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(301);
  expect(summary.oldestQueuedAgeSeconds).toBeLessThan(310);
});
