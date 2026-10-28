import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
const fake = vi.hoisted(() => ({
  path: vi.fn(), check: vi.fn(), open: vi.fn(), mysql: vi.fn(), report: vi.fn(), lookup: vi.fn(), pg: vi.fn(),
}));
vi.mock("../src/lib/wms-openvpn", () => ({
  mysqlConnectionPath: fake.path, checkOpenVpn: fake.check, openVpnMysqlStream: fake.open,
}));
vi.mock("../src/lib/wms-mysql-connection", () => ({
  testMysqlConnection: fake.mysql, runMysqlReport: fake.report,
}));
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
vi.mock("pg", () => ({ default: { Pool: fake.pg } }));
import { executeApprovedMysqlReport, testConnection, testWmsVpn, ConnectionFailure } from "../src/lib/wms-connection";

const input = { engine: "mysql" as const, host: "mysql.internal.example.test", port: 3306,
  database: "reporting", schema: "reporting", username: "reporter",
  sslMode: "verify-full" as const, queryTimeoutSec: 15 };
const mapping = { view: "v_stock", clientColumn: "client", siteColumn: "site", columns: { sku: "sku" } };
beforeEach(() => {
  vi.clearAllMocks();
  fake.path.mockReturnValue("openvpn");
  fake.check.mockResolvedValue(undefined);
  fake.open.mockImplementation(async () => new PassThrough());
  fake.mysql.mockResolvedValue({ status: "connected" });
  fake.report.mockResolvedValue({ columns: ["sku"], rows: [], truncated: false });
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", "mysql://reporter:fixture@mysql.internal.example.test/reporting");
  for (const key of ["WMS_MYSQL_PASSWORD", "WMS_MYSQL_APPROVED_HOST", "WMS_MYSQL_APPROVED_PORT",
    "WMS_MYSQL_APPROVED_DATABASE", "WMS_MYSQL_APPROVED_USERNAME"]) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

test("VPN-only check validates exact destination before network and never starts SQL", async () => {
  expect((await testWmsVpn({ ...input, host: "other.example.test" })).status).toBe("error");
  expect(fake.check).not.toHaveBeenCalled();
  expect((await testWmsVpn(input)).status).toBe("ready");
  expect(fake.check).toHaveBeenCalledOnce();
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.mysql).not.toHaveBeenCalled();
});

test("VPN readiness can be checked before a SQL password is configured", async () => {
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", undefined);
  vi.stubEnv("WMS_MYSQL_APPROVED_HOST", input.host);
  vi.stubEnv("WMS_MYSQL_APPROVED_PORT", String(input.port));
  vi.stubEnv("WMS_MYSQL_APPROVED_DATABASE", input.database);
  vi.stubEnv("WMS_MYSQL_APPROVED_USERNAME", input.username);
  expect((await testWmsVpn(input)).status).toBe("ready");
  expect(fake.mysql).not.toHaveBeenCalled();
  expect(await testConnection(input)).toMatchObject({ status: "error", code: "PASSWORD_NOT_CONFIGURED" });
  expect(fake.open).not.toHaveBeenCalled();
});

test("a failed VPN prevents MySQL and direct database DNS/PG access", async () => {
  fake.open.mockRejectedValue(new ConnectionFailure("VPN_NOT_READY", "VPN unavailable"));
  expect(await testConnection(input)).toMatchObject({ status: "error", code: "VPN_NOT_READY" });
  expect(fake.mysql).not.toHaveBeenCalled();
  expect(fake.lookup).not.toHaveBeenCalled();
  expect(fake.pg).not.toHaveBeenCalled();
});

test("SQL receives only the connector stream and cleans it up on completion", async () => {
  const stream = new PassThrough();
  fake.open.mockResolvedValue(stream);
  await testConnection(input);
  expect(fake.mysql).toHaveBeenCalledWith(input, "fixture", input.host, stream);
  expect(stream.destroyed).toBe(true);
  expect(fake.lookup).not.toHaveBeenCalled();
});

test("live reports use the same mandatory tunnel and clean it up after SQL failure", async () => {
  const stream = new PassThrough();
  fake.open.mockResolvedValue(stream);
  fake.report.mockRejectedValue(new Error("query failed"));
  await expect(executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }))
    .rejects.toThrow("query failed");
  expect(fake.report.mock.calls[0].at(-1)).toBe(stream);
  expect(stream.destroyed).toBe(true);
  expect(fake.lookup).not.toHaveBeenCalled();
});

test("reports cannot bypass unavailable VPN by switching to a direct socket", async () => {
  fake.open.mockRejectedValue(new ConnectionFailure("VPN_NOT_READY", "VPN unavailable"));
  await expect(executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }))
    .rejects.toMatchObject({ code: "VPN_NOT_READY" });
  expect(fake.report).not.toHaveBeenCalled();
  expect(fake.lookup).not.toHaveBeenCalled();
});
