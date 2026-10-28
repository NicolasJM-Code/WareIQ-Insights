import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initialVpnHealth, type VpnHealthState } from "../src/lib/wms-vpn-health";

const fixture = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), connect: vi.fn(), probe: vi.fn(), directory: vi.fn(),
  input: vi.fn(), network: vi.fn(), warn: vi.fn(),
}));
vi.mock("pg", () => ({ default: { Pool: class {
  on() {}
  connect = fixture.connect;
  query = fixture.query;
} } }));
vi.mock("@clerk/express", () => ({ clerkClient: { users: { getUserList: fixture.directory } } }));
vi.mock("../src/lib/wms-connection", () => ({ configuredMysqlReportInput: fixture.input }));
vi.mock("../src/lib/wms-openvpn", () => ({ checkOpenVpn: fixture.probe, getWmsNetworkConfig: fixture.network }));
vi.mock("../src/lib/logger", () => ({ logger: { warn: fixture.warn } }));
import { checkWarehouseVpnHealth, startWarehouseVpnMonitor, warehouseVpnHealth, vpnAdministrators } from "../src/lib/wms-vpn-monitor";
import { ConnectionFailure } from "../src/lib/wms-connection-error";

let stored: { config_key: string; state: VpnHealthState; due: boolean } | undefined;
let staged: typeof stored;
let queued: Array<{ kind: string; recipients: unknown[] }>;
let committed: typeof queued;
let locked: boolean;
let storageFails: boolean;
const administrator = {
  id: "fixture-admin", banned: false, locked: false, publicMetadata: { role: "admin" },
  primaryEmailAddressId: "primary",
  emailAddresses: [{ id: "primary", emailAddress: "admin@example.test", verification: { status: "verified" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  stored = undefined; staged = undefined; queued = []; committed = [];
  locked = true; storageFails = false;
  fixture.network.mockReturnValue({ path: "openvpn", configured: true });
  fixture.input.mockReturnValue({ engine: "mysql", host: "db.example.test", port: 3306,
    database: "reporting", schema: "reporting", username: "reader", sslMode: "verify-full", queryTimeoutSec: 15 });
  fixture.probe.mockResolvedValue(undefined);
  fixture.directory.mockResolvedValue({ data: [administrator], totalCount: 1 });
  fixture.connect.mockResolvedValue({ query: fixture.query, release: fixture.release, on: vi.fn(), removeListener: vi.fn() });
  fixture.query.mockImplementation(async (sql: string, args?: string[]) => {
    if (storageFails) throw new Error("sensitive-storage-fixture");
    if (sql === "BEGIN") { staged = stored; queued = []; }
    if (sql.includes("pg_try_advisory")) return { rows: [{ locked }] };
    if (sql.startsWith("SELECT config_key")) return { rows: stored ? [stored] : [] };
    if (sql.startsWith("SELECT state")) return { rows: stored ? [{ state: stored.state }] : [] };
    if (sql.startsWith("INSERT INTO wareiq_access")) queued.push({ kind: args![1], recipients: JSON.parse(args![0]) });
    if (sql.startsWith("INSERT INTO wareiq_wms")) staged = { config_key: args![0], state: JSON.parse(args![1]), due: true };
    if (sql === "COMMIT") { stored = staged; committed.push(...queued); }
    return { rows: [] };
  });
});
afterEach(() => vi.useRealTimers());
const unavailable = () => fixture.probe.mockRejectedValue(new ConnectionFailure("VPN_NOT_READY", "private-fixture"));

test("outage and recovery are queued atomically and sustained failures survive worker restarts", async () => {
  unavailable();
  await checkWarehouseVpnHealth();
  expect(committed).toEqual([]);
  await checkWarehouseVpnHealth();
  expect(committed.map((n) => n.kind)).toEqual(["vpn_outage"]);
  for (let i = 0; i < 4; i++) await checkWarehouseVpnHealth();
  expect(committed).toHaveLength(1);
  fixture.probe.mockResolvedValue(undefined);
  await checkWarehouseVpnHealth();
  await checkWarehouseVpnHealth();
  expect(committed.map((n) => n.kind)).toEqual(["vpn_outage", "vpn_recovery"]);
  expect(committed[0].recipients).toEqual([expect.objectContaining({ email: "admin@example.test", target: "fixture-admin" })]);
  expect(await warehouseVpnHealth()).toMatchObject({ status: "healthy" });
});

test("lock contention and persisted schedule prevent duplicate probes across instances", async () => {
  locked = false;
  await checkWarehouseVpnHealth();
  expect(fixture.probe).not.toHaveBeenCalled();
  locked = true;
  await checkWarehouseVpnHealth();
  stored!.due = false;
  await checkWarehouseVpnHealth();
  expect(fixture.probe).toHaveBeenCalledTimes(1);
  expect(fixture.release).toHaveBeenCalledTimes(3);
});

test("monitoring exceptions are unknown, break the failure sequence, and cannot recover an outage", async () => {
  unavailable();
  await checkWarehouseVpnHealth();
  fixture.probe.mockRejectedValue(new Error("secret-token-fixture"));
  await checkWarehouseVpnHealth();
  expect(await warehouseVpnHealth()).toEqual({ status: "unknown", checkedAt: null });
  expect(committed).toHaveLength(0);
  unavailable();
  await checkWarehouseVpnHealth();
  expect(committed).toHaveLength(0);
  await checkWarehouseVpnHealth();
  fixture.probe.mockRejectedValue(new Error("secret-token-fixture"));
  await checkWarehouseVpnHealth();
  expect(committed.map((n) => n.kind)).toEqual(["vpn_outage"]);
});

test("directory/queue failures roll back a transition for retry and never reveal stale healthy status", async () => {
  unavailable();
  await checkWarehouseVpnHealth();
  fixture.directory.mockRejectedValue(new Error("secret-directory-fixture"));
  await expect(checkWarehouseVpnHealth()).rejects.toThrow("Warehouse monitor unavailable");
  expect(committed).toHaveLength(0);
  expect(stored!.state.failures).toBe(1);
  expect(fixture.query).toHaveBeenCalledWith("ROLLBACK");
  fixture.directory.mockResolvedValue({ data: [administrator], totalCount: 1 });
  await checkWarehouseVpnHealth();
  expect(committed).toHaveLength(1);
  fixture.query.mockRejectedValueOnce(new Error("storage-secret"));
  expect(await warehouseVpnHealth()).toEqual({ status: "unknown", checkedAt: null });
});

test("direct, missing configuration, absent and stale observations do not claim connectivity", async () => {
  expect(await warehouseVpnHealth()).toMatchObject({ status: "unknown" });
  await checkWarehouseVpnHealth();
  stored!.state.checkedAt = "2020-01-01T00:00:00.000Z";
  expect(await warehouseVpnHealth()).toMatchObject({ status: "unknown" });
  fixture.network.mockReturnValue({ path: "openvpn", configured: false });
  expect(await warehouseVpnHealth()).toMatchObject({ status: "unknown" });
  fixture.network.mockReturnValue({ path: "direct", configured: true });
  await checkWarehouseVpnHealth();
  expect(await warehouseVpnHealth()).toEqual({ status: "disabled", checkedAt: null });
  expect(fixture.probe).toHaveBeenCalledTimes(1);
  expect(committed).toHaveLength(0);
});

test("administrator discovery paginates and excludes unverified, restricted and non-admin accounts", async () => {
  fixture.directory
    .mockResolvedValueOnce({ data: [{ ...administrator, banned: true }], totalCount: 101 })
    .mockResolvedValueOnce({ data: [
      administrator,
      { ...administrator, publicMetadata: { role: "supervisor" } },
      { ...administrator, primaryEmailAddressId: "other" },
    ], totalCount: 101 });
  expect(await vpnAdministrators()).toEqual([{ id: "fixture-admin", email: "admin@example.test" }]);
  expect(fixture.directory.mock.calls.map(([arg]) => arg.offset)).toEqual([0, 100]);
});

test("bounded directory timeout rolls back and a stalled probe does not overlap subsequent ticks", async () => {
  vi.useFakeTimers();
  unavailable();
  await checkWarehouseVpnHealth();
  fixture.directory.mockReturnValue(new Promise(() => {}));
  const pending = expect(checkWarehouseVpnHealth()).rejects.toThrow("Warehouse monitor unavailable");
  await vi.advanceTimersByTimeAsync(8000);
  await pending;
  expect(committed).toHaveLength(0);
  expect(stored!.state.failures).toBe(1);
  fixture.probe.mockReturnValue(new Promise(() => {}));
  startWarehouseVpnMonitor();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(fixture.probe).toHaveBeenCalledTimes(3);
  expect(fixture.warn).toHaveBeenCalledWith({ event: "wms_vpn_monitor_unknown" }, expect.any(String));
  expect(await warehouseVpnHealth()).toMatchObject({ status: "unknown" });
  expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("secret");
  vi.clearAllTimers();
});
