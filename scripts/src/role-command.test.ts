import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRoleCommand, runRoleCommand } from "./role-command";

type Directory = Parameters<typeof runRoleCommand>[1];
type User = Awaited<ReturnType<Directory["getUser"]>>;
function user(role = "unassigned", overrides: Partial<User> = {}): User {
  return {
    id: "user_target", publicMetadata: { role, private: "provider-metadata" },
    emailAddresses: [{ emailAddress: "private@example.test", verification: { status: "verified" } }],
    banned: false, locked: false, ...overrides,
  } as User;
}
const store = { start: vi.fn(), target: vi.fn(), previous: vi.fn(), finish: vi.fn() };
const users = { getUserList: vi.fn(), getUser: vi.fn(), updateUserMetadata: vi.fn() };
const input = { email: "private@example.test", role: "admin" as const, actorId: "operator:ops-alias" };
const direct = async <T>(operation: () => Promise<T>) => operation();
const lock = vi.fn(direct);
const testLock = async <T>(operation: () => Promise<T>): Promise<T> => lock(operation) as Promise<T>;
const run = () => runRoleCommand(input, users as unknown as Directory, store, testLock);
beforeEach(() => {
  vi.resetAllMocks();
  store.start.mockResolvedValue("audit-id");
  users.getUserList.mockResolvedValue({ data: [user()], totalCount: 1 });
  users.getUser.mockResolvedValue(user());
  users.updateUserMetadata.mockResolvedValue(user("admin"));
  lock.mockImplementation(direct);
});

describe("operator command validation", () => {
  const valid = ["--email", input.email, "--role", "admin", "--operator-id", "ops-alias", "--confirm-ownership"];
  it("normalizes email and namespaces the attested operator, not a Clerk identity", () => {
    expect(parseRoleCommand(valid, false)).toEqual(input);
    expect(parseRoleCommand([...valid.slice(0, 1), " Private@Example.Test ", ...valid.slice(2)], false)).toEqual(input);
  });
  it.each(["private@example.test", "A Name", "x", "ops\nforged"])("rejects unsafe operator %s", (operator) => {
    expect(() => parseRoleCommand(valid.map((v) => v === "ops-alias" ? operator : v), false)).toThrow();
  });
  it("cannot present a provider-like alias as an authenticated actor", () => {
    expect(parseRoleCommand(valid.map((v) => v === "ops-alias" ? "user_provider" : v), false).actorId).toBe("operator:user_provider");
  });
  it("rejects missing identity, ownership, duplicate and unknown arguments", () => {
    expect(() => parseRoleCommand(valid.filter((v) => !["--operator-id", "ops-alias"].includes(v)), false)).toThrow();
    expect(() => parseRoleCommand(valid.slice(0, -1), false)).toThrow();
    expect(() => parseRoleCommand([...valid, "--role", "unassigned"], false)).toThrow();
    expect(() => parseRoleCommand([...valid, "--extra"], false)).toThrow();
  });
  it("requires production confirmation", () => {
    expect(() => parseRoleCommand(valid, true)).toThrow();
    expect(parseRoleCommand([...valid, "--confirm-production"], true)).toEqual(input);
  });
});

describe("durable command history", () => {
  it("saves minimal intent before lock/lookup and prior role before dispatch, without metadata", async () => {
    lock.mockImplementation(async (operation) => {
      expect(store.start).toHaveBeenCalledWith({ actorId: input.actorId, targetId: null, requestedRole: "admin" });
      return operation();
    });
    users.updateUserMetadata.mockImplementation(async (...args) => {
      expect(store.target).toHaveBeenCalledWith("audit-id", "user_target");
      expect(store.previous).toHaveBeenCalledWith("audit-id", "unassigned");
      expect(args).toEqual(["user_target", { publicMetadata: { role: "admin" } }]);
      return user("admin");
    });
    await expect(run()).resolves.toEqual({ id: "audit-id", changed: true });
    expect(store.finish).toHaveBeenCalledWith("audit-id", "succeeded", "role_confirmed", "admin");
    expect(JSON.stringify([store.start.mock.calls, store.target.mock.calls, store.previous.mock.calls, store.finish.mock.calls]))
      .not.toMatch(/private@example|provider-metadata|emailAddresses/);
  });
  it("never contacts Clerk or the lock if intent persistence fails", async () => {
    store.start.mockRejectedValue(new Error("db"));
    await expect(run()).rejects.toThrow();
    expect(lock).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
  });
  it.each(["target", "previous"] as const)("does not write provider if %s evidence fails", async (method) => {
    store[method].mockRejectedValue(new Error("db"));
    await expect(run()).rejects.toThrow();
    expect(users.updateUserMetadata).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith("audit-id", "failed", "change_not_started");
  });
  it("records unchanged grants without dispatch", async () => {
    users.getUser.mockResolvedValue(user("admin"));
    await expect(run()).resolves.toMatchObject({ changed: false });
    expect(users.updateUserMetadata).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith("audit-id", "unchanged", "already_assigned", "admin");
  });
  it("records revocations, even emergency self/last-admin recovery", async () => {
    users.getUser.mockResolvedValue(user("admin"));
    users.updateUserMetadata.mockResolvedValue(user("unassigned"));
    await runRoleCommand({ ...input, role: "unassigned" }, users as unknown as Directory, store, testLock);
    expect(store.previous).toHaveBeenCalledWith("audit-id", "admin");
    expect(store.finish).toHaveBeenCalledWith("audit-id", "succeeded", "role_confirmed", "unassigned");
  });
  it.each([[], [user(), user()], [user("unassigned", { id: "arbitrary@text" })]].map((data) => ({ data })))("denies unsafe or ambiguous resolution", async ({ data }) => {
    users.getUserList.mockResolvedValue({ data });
    await expect(run()).rejects.toThrow();
    expect(store.finish).toHaveBeenCalledWith("audit-id", "denied", "command_target_ineligible");
    expect(users.updateUserMetadata).not.toHaveBeenCalled();
  });
  it.each([{ banned: true }, { locked: true }, { emailAddresses: [] }])("denies ineligible fresh targets", async (overrides) => {
    users.getUser.mockResolvedValue(user("unassigned", overrides));
    await expect(run()).rejects.toThrow();
    expect(store.finish).toHaveBeenCalledWith("audit-id", "denied", "command_target_ineligible");
    expect(users.updateUserMetadata).not.toHaveBeenCalled();
  });
  it.each(["lookup", "lock"])("records %s failure as not attempted", async (stage) => {
    (stage === "lookup" ? users.getUserList : lock).mockRejectedValue(new Error("raw provider payload"));
    await expect(run()).rejects.toThrow("not attempted");
    expect(store.finish).toHaveBeenCalledWith("audit-id", "failed", "change_not_started");
    expect(users.updateUserMetadata).not.toHaveBeenCalled();
  });
  it.each(["timeout", "mismatch", "commit"])("leaves %s after dispatch unconfirmed", async (stage) => {
    if (stage === "timeout") users.updateUserMetadata.mockRejectedValue({ status: 404, metadata: "private" });
    if (stage === "mismatch") users.updateUserMetadata.mockResolvedValue(user());
    if (stage === "commit") lock.mockImplementation(async (operation) => { await operation(); throw new Error("commit"); });
    await expect(run()).rejects.toThrow("unconfirmed");
    expect(store.finish).toHaveBeenCalledWith("audit-id", "unconfirmed", "provider_outcome_unknown");
  });
  it("cannot report success when final evidence fails", async () => {
    store.finish.mockRejectedValue(new Error("db"));
    await expect(run()).rejects.toThrow();
    expect(users.updateUserMetadata).toHaveBeenCalledOnce();
    expect(store.finish).toHaveBeenCalledOnce();
    expect(store.start).toHaveBeenCalledOnce();
  });
});
