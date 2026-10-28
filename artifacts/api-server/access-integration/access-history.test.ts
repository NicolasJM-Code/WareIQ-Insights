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
type Cursor = { beforeTime: string; beforeId: string };
type Page = { entries: Entry[]; nextCursor: Cursor | null };
type Message = { event: string; id?: string; page?: Page };
const database = new PrivateDatabase();
const children: ChildProcess[] = [];
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");

function launch(kind: Kind | "history", fault = "", cursor?: Cursor) {
  const child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [
    kind, fault, JSON.stringify(cursor ?? null),
  ], {
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

async function historyPage(cursor?: Cursor) {
  const reader = launch("history", "", cursor);
  const message = await reader.wait("history");
  await reader.exited;
  expect(reader.child.exitCode).toBe(0);
  return message.page!;
}

async function history() {
  return (await historyPage()).entries;
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

async function rejectFinalWrites() {
  await database.pool.query(`
    CREATE OR REPLACE FUNCTION reject_audit_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'integration final write failure'; END $$;
    CREATE TRIGGER reject_finish BEFORE UPDATE ON access_change_history
      FOR EACH ROW WHEN (NEW.finished_at IS NOT NULL) EXECUTE FUNCTION reject_audit_finish()`);
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
  await database.pool.query(`
    DROP TRIGGER IF EXISTS reject_intent ON access_change_history;
    DROP TRIGGER IF EXISTS reject_previous ON access_change_history;
    DROP FUNCTION IF EXISTS reject_early_audit_write()`);
});
afterAll(() => database.stop());

it("resumes cursor pagination without missing or duplicated history after PostgreSQL recovery", async () => {
  // Insert IDs in ascending order, opposite the required descending tie-break.
  // Both page boundaries lie inside timestamp ties (32 newer + 31 older rows).
  const fixtures = Array.from({ length: 63 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: index < 32 ? "2026-01-02T12:00:00.123Z" : "2026-01-01T12:00:00.456Z",
    finishedAt: "2026-01-03T12:00:00.789Z",
  }));
  await database.pool.query(`
    INSERT INTO access_change_history
      (id, created_at, finished_at, actor_id, target_id, previous_role,
       requested_role, resulting_role, outcome, reason)
    SELECT id::uuid, created_at::timestamptz, finished_at::timestamptz,
      'operator:pagination-fixture', 'user_synthetic', 'unassigned',
      'supervisor', 'supervisor', 'succeeded', 'confirmed'
    FROM jsonb_to_recordset($1::jsonb)
      AS fixture(id text, created_at text, finished_at text)`,
  [JSON.stringify(fixtures.map((row) => ({
    id: row.id, created_at: row.createdAt, finished_at: row.finishedAt,
  })))]);
  // Independently derive the expected order and exact timestamps, rather than
  // using another call to the pagination implementation as the oracle.
  const expected = [...fixtures].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const identity = (entry: Entry) => ({
    id: entry.id, createdAt: entry.createdAt, finishedAt: entry.finishedAt,
  });
  const first = await historyPage();
  expect(first.entries.map(identity)).toEqual(expected.slice(0, 25));
  const savedCursor = {
    beforeTime: expected[24]!.createdAt, beforeId: expected[24]!.id,
  };
  expect(first.nextCursor).toEqual(savedCursor);

  const recoveryLog = await database.crashAndRestart();
  expect(recoveryLog).toContain("database system was interrupted");
  expect(recoveryLog).toContain("automatic recovery in progress");
  expect(await historyPage()).toEqual(first);

  // Replay the pre-crash cursor twice. Each page comes from a fresh application
  // process, so no old pool or in-memory cursor state can conceal lost evidence.
  for (let replay = 0; replay < 2; replay++) {
    const second = await historyPage(savedCursor);
    expect(second.entries.map(identity)).toEqual(expected.slice(25, 50));
    expect(second.nextCursor).toEqual({
      beforeTime: expected[49]!.createdAt, beforeId: expected[49]!.id,
    });
    const third = await historyPage(second.nextCursor!);
    expect(third.entries.map(identity)).toEqual(expected.slice(50));
    expect(third.nextCursor).toBeNull();
    const all = [...first.entries, ...second.entries, ...third.entries];
    expect(all.map(identity)).toEqual(expected);
    expect(new Set(all.map((entry) => entry.id)).size).toBe(fixtures.length);
  }
});

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

it.each(
  (["api", "command"] as const).flatMap((kind) =>
    ["", "provider-error", "finish-error"].map((fault) => ({ kind, fault }))),
)("$kind gracefully rejects a lost role-lock connection and remains available ($fault)", async ({ kind, fault }) => {
  if (fault === "finish-error") await rejectFinalWrites();
  const worker = launch(kind, fault);
  await worker.wait("dispatch");
  const entry = await pending(worker, kind);
  // Kill only the backend holding this private cluster's advisory lock.
  const killed = await database.pool.query(`
    SELECT pg_terminate_backend(pid) AS killed FROM pg_locks
    WHERE locktype = 'advisory' AND granted`);
  expect(killed.rows).toEqual([{ killed: true }]);
  // Read back while the provider is still paused. The production client error
  // listener must keep the process alive without rewriting pending evidence.
  expect(await history()).toEqual([entry]);
  expect(worker.child.exitCode).toBeNull();
  worker.release();
  await worker.wait("failure");
  await worker.wait("available");
  await worker.exited;
  expect(worker.child.exitCode).toBe(0);
  expect(worker.child.signalCode).toBeNull();
  expect(worker.messages.some((m) => m.event === "success")).toBe(false);
  // Never turn a provider response into confirmed success after losing the
  // lock. Preserve the original account, actor, requested role and timestamps.
  expect(await history()).toEqual([fault === "finish-error" ? entry : {
    ...entry, outcome: "unconfirmed", reason: "provider_outcome_unknown",
    finishedAt: expect.any(String),
  }]);
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
  await rejectFinalWrites();
  const worker = launch(kind);
  await worker.wait("dispatch");
  const entry = await pending(worker, kind);
  worker.release();
  await worker.wait("failure");
  await worker.exited;
  expect(worker.messages.some((m) => m.event === "success")).toBe(false);
  expect(await history()).toEqual([entry]);
});

it.each<Kind>(["api", "command"])("%s never dispatches if PostgreSQL rejects the initial intent INSERT", async (kind) => {
  await database.pool.query(`
    CREATE FUNCTION reject_early_audit_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'integration intent insert failure'; END $$;
    CREATE TRIGGER reject_intent BEFORE INSERT ON access_change_history
      FOR EACH ROW EXECUTE FUNCTION reject_early_audit_write()`);
  const worker = launch(kind);
  await worker.wait("failure");
  await worker.wait("available");
  await worker.exited;
  expect(worker.child.exitCode).toBe(0);
  expect(worker.child.signalCode).toBeNull();
  expect(worker.messages.some((m) =>
    m.event === "intent" || m.event === "dispatch" || m.event === "success")).toBe(false);
  // A rejected INSERT must not fabricate a successful or pending history row.
  // This uses accessHistoryPage in a new process, not the writer's pool.
  expect(await history()).toEqual([]);
});

it.each<Kind>(["api", "command"])("%s never dispatches if PostgreSQL rejects the previous-role UPDATE", async (kind) => {
  await database.pool.query(`
    CREATE FUNCTION reject_early_audit_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'integration previous role update failure'; END $$;
    CREATE TRIGGER reject_previous BEFORE UPDATE OF previous_role ON access_change_history
      FOR EACH ROW EXECUTE FUNCTION reject_early_audit_write()`);
  const worker = launch(kind);
  const { id } = await worker.wait("intent");
  await worker.wait("failure");
  await worker.wait("available");
  await worker.exited;
  expect(worker.child.exitCode).toBe(0);
  expect(worker.child.signalCode).toBeNull();
  expect(worker.messages.some((m) => m.event === "dispatch" || m.event === "success")).toBe(false);

  // Reject only previous_role: target resolution and failure finalization must
  // still commit independently of the rolled-back role-lock transaction.
  const entries = await history();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    id, actorId: kind === "api" ? "user_actor" : "operator:integration",
    targetId: "user_target", previousRole: null, requestedRole: "supervisor",
    resultingRole: null, outcome: "failed", reason: "change_not_started",
    createdAt: expect.any(String), finishedAt: expect.any(String),
  });
  expect(Number.isFinite(Date.parse(entries[0].createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(entries[0].finishedAt!))).toBe(true);
  expect(await history()).toEqual(entries);
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

it.each<Kind>(["api", "command"])("%s retains identical pending evidence after PostgreSQL crashes and restarts", async (kind) => {
  const worker = launch(kind);
  await worker.wait("dispatch");
  // Read through accessHistoryPage in a separate process before the crash:
  // both the intent and previous-role evidence must already be committed
  // independently of the in-flight role-lock transaction.
  const entry = await pending(worker, kind);
  expect(entry.id).toEqual(expect.any(String));
  expect(Number.isFinite(Date.parse(entry.createdAt))).toBe(true);

  const recoveryLog = await database.crashAndRestart();
  expect(recoveryLog).toContain("database system was interrupted");
  expect(recoveryLog).toContain("automatic recovery in progress");
  await worker.exited;
  expect(worker.child.exitCode).not.toBe(0);
  expect(worker.messages.some((m) => m.event === "success")).toBe(false);

  // These fork fresh application processes, not just new queries on an old
  // pool. Full equality covers IDs, actor/target, previous role, timestamps,
  // and the still-unconfirmed outcome after PostgreSQL's WAL recovery.
  expect(await history()).toEqual([entry]);
  expect(await history()).toEqual([entry]);
  // Recovery must also release the aborted transaction's advisory lock.
  const recovery = launch(kind === "api" ? "command" : "api");
  await recovery.wait("dispatch");
  recovery.release();
  await recovery.wait("success");
  expect((await history()).find((row) => row.id === entry.id)).toEqual(entry);
});
