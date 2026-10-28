import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  insert: vi.fn(), values: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(),
  connect: vi.fn(), query: vi.fn(), release: vi.fn(),
}));
vi.mock("../../../lib/db/src/index", () => ({
  db: { insert: fake.insert, update: fake.update },
  pool: { connect: fake.connect },
  accessHistoryTable: { id: "id" },
}));
import { accessAuditStore, withRoleLock } from "../../../lib/db/src/access-audit";

let connection: EventEmitter;
beforeEach(() => {
  vi.resetAllMocks();
  fake.insert.mockReturnValue({ values: fake.values });
  fake.update.mockReturnValue({ set: fake.set });
  fake.set.mockReturnValue({ where: fake.where });
  connection = Object.assign(new EventEmitter(), { query: fake.query, release: fake.release });
  fake.connect.mockResolvedValue(connection);
});
it("projects only safe audit fields rather than arbitrary extra provider data", async () => {
  const entry = {
    actorId: "operator:ops-alias", targetId: null, requestedRole: "admin" as const,
    metadata: "never-store", email: "never-store@example.test",
  };
  const id = await accessAuditStore.start(entry);
  expect(fake.values).toHaveBeenCalledWith({
    id, actorId: entry.actorId, targetId: null, requestedRole: "admin",
    outcome: undefined, reason: undefined, finishedAt: null,
  });
});
it("shares Settings' lock key and commits evidence outside the lock transaction", async () => {
  await withRoleLock(async () => {
    await accessAuditStore.start({ actorId: "operator:ops-alias", targetId: null, requestedRole: "admin" });
    expect(fake.values).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls).toEqual([
      ["BEGIN"], ["SET LOCAL lock_timeout = '5s'"], ["SELECT pg_advisory_xact_lock(174983, 1)"],
    ]);
  });
  expect(fake.query).toHaveBeenLastCalledWith("COMMIT");
  expect(fake.release).toHaveBeenCalledOnce();
});
it("rolls back and releases the lock on uncertain commit errors without deleting independent evidence", async () => {
  fake.query.mockImplementation(async (query: string) => {
    if (query === "COMMIT") throw new Error("commit");
  });
  await expect(withRoleLock(async () => {
    await accessAuditStore.start({ actorId: "operator:ops-alias", targetId: null, requestedRole: "admin" });
  })).rejects.toThrow("commit");
  expect(fake.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(fake.release).toHaveBeenCalledOnce();
  expect(fake.values).toHaveBeenCalledOnce();
});

it("discards a client lost during provider work and never commits its result", async () => {
  const error = new Error("role lock disconnected");
  await expect(withRoleLock(async () => {
    connection.emit("error", error);
    await Promise.resolve();
    return "provider returned success";
  })).rejects.toBe(error);
  expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  expect(fake.query.mock.calls.map(([sql]) => sql)).not.toContain("ROLLBACK");
  expect(fake.release).toHaveBeenCalledExactlyOnceWith(error);
  expect(connection.listenerCount("error")).toBe(0);
});

it("retains the first connection failure when provider work also rejects", async () => {
  const error = new Error("first connection failure");
  await expect(withRoleLock(async () => {
    connection.emit("error", error);
    connection.emit("error", new Error("later connection failure"));
    throw new Error("provider failure");
  })).rejects.toBe(error);
  expect(fake.release).toHaveBeenCalledExactlyOnceWith(error);
});

it("discards the client when rollback fails", async () => {
  const error = new Error("rollback failed");
  fake.query.mockImplementation(async (sql: string) => {
    if (sql === "ROLLBACK") throw error;
  });
  await expect(withRoleLock(async () => {
    throw new Error("operation failed");
  })).rejects.toBe(error);
  expect(fake.release).toHaveBeenCalledExactlyOnceWith(error);
});
