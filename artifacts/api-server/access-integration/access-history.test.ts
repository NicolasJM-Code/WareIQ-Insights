import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { PrivateDatabase } from "./database";

type Kind = "api" | "command";
type Entry = {
  id: string; actorId: string; targetId: string | null; previousRole: string | null;
  requestedRole: string; resultingRole: string | null; outcome: string;
  reason: string; finishedAt: string | null; createdAt: string;
};
type Message = { event: string; id?: string; page?: { entries: Entry[] } };
const database = new PrivateDatabase();
const children: ChildProcess[] = [];
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");

function launch(kind: Kind | "history", fault = "") {
  const child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [kind, fault], {
    execArgv: ["--import", tsx],
    // Never inherit secrets or PG connection overrides into the worker.
    env: { NODE_ENV: "test", DATABASE_URL: database.connectionString },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const messages: Message[] = [];
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message) => { messages.push(message as Message); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const wait = async (event: string) => {
    await expect.poll(() => {
      if (child.exitCode !== null && !messages.some((m) => m.event === event)) {
        throw new Error(`Worker exited before ${event}: ${stderr}`);
      }
      return messages.some((message) => message.event === event);
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    return messages.find((message) => message.event === event)!;
  };
  return { child, messages, wait, exited, release: () => child.send({ resume: true }) };
}

async function history() {
  const reader = launch("history");
  const message = await reader.wait("history");
  await reader.exited;
  return message.page!.entries;
}

async function pending(worker: ReturnType<typeof launch>, kind: Kind) {
  const { id } = await worker.wait("intent");
  const entries = await history(); // Actual application query from a fresh process.
  const entry = entries.find((row) => row.id === id)!;
  expect(entry).toMatchObject({
    id, actorId: kind === "api" ? "user_actor" : "operator:integration",
    targetId: "user_target", previousRole: "unassigned", requestedRole: "supervisor",
    outcome: "unconfirmed", reason: "confirmation_pending",
    resultingRole: null, finishedAt: null,
  });
  return entry;
}

beforeAll(() => database.start());
beforeEach(async () => {
  await database.pool.query("TRUNCATE access_change_history");
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exit;
  }));
  await database.pool.query("DROP TRIGGER IF EXISTS reject_finish ON access_change_history");
});
afterAll(() => database.stop());

it.each<Kind>(["api", "command"])("%s shares the advisory lock with the other entry point", async (kind) => {
  const first = launch(kind);
  await first.wait("dispatch");
  const second = launch(kind === "api" ? "command" : "api");
  await second.wait("intent");
  // Observe a real waiter blocked by a different PostgreSQL backend. This also
  // fails if either entry point bypasses the shared production lock.
  await expect.poll(async () => {
    const result = await database.pool.query(`
      SELECT waiter.pid FROM pg_locks waiter JOIN pg_locks holder
        ON waiter.locktype = holder.locktype AND waiter.database = holder.database
        AND waiter.classid = holder.classid AND waiter.objid = holder.objid
        AND waiter.objsubid = holder.objsubid
      WHERE waiter.locktype = 'advisory' AND NOT waiter.granted
        AND holder.granted AND waiter.pid <> holder.pid
        AND holder.pid = ANY(pg_blocking_pids(waiter.pid))`);
    return result.rowCount;
  }, { timeout: 3_000 }).toBe(1);
  expect(second.messages.some((m) => m.event === "dispatch")).toBe(false);
  first.release();
  await first.wait("success");
  await second.wait("dispatch");
  second.release();
  await second.wait("success");
  expect((await history()).map((e) => e.outcome)).toEqual(["succeeded", "succeeded"]);
});

it.each<Kind>(["api", "command"])("%s retains committed evidence when the role transaction rolls back", async (kind) => {
  const worker = launch(kind, "provider-error");
  await worker.wait("dispatch");
  const entry = await pending(worker, kind);
  worker.release();
  await worker.wait("failure");
  await worker.exited;
  expect((await history()).find((row) => row.id === entry.id)).toEqual({
    ...entry, outcome: "unconfirmed", reason: "provider_outcome_unknown",
    finishedAt: expect.any(String),
  });
  expect(worker.messages.some((m) => m.event === "success")).toBe(false);
});

it.each<Kind>(["api", "command"])("%s never reports success after losing the role-lock connection", async (kind) => {
  const worker = launch(kind);
  await worker.wait("dispatch");
  const entry = await pending(worker, kind);
  // Kill only the backend holding this private cluster's advisory lock.
  const killed = await database.pool.query(`
    SELECT pg_terminate_backend(pid) AS killed FROM pg_locks
    WHERE locktype = 'advisory' AND granted`);
  expect(killed.rows).toEqual([{ killed: true }]);
  // pg currently emits an unhandled checked-out Client error while the
  // provider is in flight. Assert the real crash rather than swallowing it in
  // the fixture, which would conceal a production failure mode.
  await worker.exited;
  expect(worker.child.exitCode).not.toBe(0);
  expect(worker.messages.some((m) => m.event === "success")).toBe(false);
  expect(await history()).toEqual([entry]);
});

it.each<Kind>(["api", "command"])("%s preserves its intent when the shared role lock times out", async (kind) => {
  const holder = launch(kind === "api" ? "command" : "api");
  await holder.wait("dispatch");
  const waiter = launch(kind);
  const { id } = await waiter.wait("intent");
  await waiter.wait("failure"); // The production lock_timeout is five seconds.
  await waiter.exited;
  expect(waiter.messages.some((m) => m.event === "dispatch" || m.event === "success")).toBe(false);
  expect((await history()).find((row) => row.id === id)).toMatchObject({
    id, actorId: kind === "api" ? "user_actor" : "operator:integration",
    outcome: "failed", reason: "change_not_started", previousRole: null,
    targetId: kind === "api" ? "user_target" : null,
  });
  holder.release();
  await holder.wait("success");
});

it.each<Kind>(["api", "command"])("%s keeps pending intent if PostgreSQL rejects final persistence", async (kind) => {
  await database.pool.query(`
    CREATE OR REPLACE FUNCTION reject_audit_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'integration final write failure'; END $$;
    CREATE TRIGGER reject_finish BEFORE UPDATE ON access_change_history
      FOR EACH ROW WHEN (NEW.finished_at IS NOT NULL) EXECUTE FUNCTION reject_audit_finish()`);
  const worker = launch(kind);
  await worker.wait("dispatch");
  const entry = await pending(worker, kind);
  worker.release();
  await worker.wait("failure");
  await worker.exited;
  expect(worker.messages.some((m) => m.event === "success")).toBe(false);
  expect(await history()).toEqual([entry]);
});

it.each<Kind>(["api", "command"])("%s survives process interruption after provider dispatch and reads back unchanged", async (kind) => {
  const worker = launch(kind);
  await worker.wait("dispatch");
  const entry = await pending(worker, kind);
  worker.child.kill("SIGKILL");
  await worker.exited;
  expect(worker.child.signalCode).toBe("SIGKILL");
  // Two new application processes must return identical IDs, timestamps and
  // pending evidence; current fake provider state is not historical proof.
  expect(await history()).toEqual([entry]);
  expect(await history()).toEqual([entry]);
  // Process death must release the role lock so recovery can proceed.
  const recovery = launch(kind === "api" ? "command" : "api");
  await recovery.wait("dispatch");
  recovery.release();
  await recovery.wait("success");
  expect((await history()).find((row) => row.id === entry.id)).toEqual(entry);
});
