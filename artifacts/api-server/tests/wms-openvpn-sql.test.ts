import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { configureVpnSite, vpnScope, vpnSite } from "./fixtures/wms-vpn-sites";
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

const input = { siteId: vpnScope.siteId, engine: "mysql" as const, host: "mysql.internal.example.test", port: 3306,
  database: "reporting", schema: "reporting", username: "reporter",
  sslMode: "verify-full" as const, queryTimeoutSec: 15 };
const mapping = { view: "v_stock", clientColumn: "client", siteColumn: "site", columns: { sku: "sku" } };
beforeEach(() => {
  vi.clearAllMocks();
  configureVpnSite();
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
  expect((await testWmsVpn({ ...input, host: "other.example.test" }, vpnScope)).status).toBe("error");
  expect(fake.check).not.toHaveBeenCalled();
  expect((await testWmsVpn(input, vpnScope)).status).toBe("ready");
  expect(fake.check).toHaveBeenCalledOnce();
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.mysql).not.toHaveBeenCalled();
});

test("VPN readiness can be checked before a SQL password is configured", async () => {
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", undefined);
  vi.stubEnv(vpnSite.passwordEnv, undefined);
  vi.stubEnv("WMS_MYSQL_APPROVED_HOST", input.host);
  vi.stubEnv("WMS_MYSQL_APPROVED_PORT", String(input.port));
  vi.stubEnv("WMS_MYSQL_APPROVED_DATABASE", input.database);
  vi.stubEnv("WMS_MYSQL_APPROVED_USERNAME", input.username);
  expect((await testWmsVpn(input, vpnScope)).status).toBe("ready");
  expect(fake.mysql).not.toHaveBeenCalled();
  expect(await testConnection(input, { siteScope: vpnScope })).toMatchObject({ status: "error", code: "PASSWORD_NOT_CONFIGURED" });
  expect(fake.open).not.toHaveBeenCalled();
});

test("a failed VPN prevents MySQL and direct database DNS/PG access", async () => {
  fake.open.mockRejectedValue(new ConnectionFailure("VPN_NOT_READY", "VPN unavailable"));
  expect(await testConnection(input, { siteScope: vpnScope })).toMatchObject({ status: "error", code: "VPN_NOT_READY" });
  expect(fake.mysql).not.toHaveBeenCalled();
  expect(fake.lookup).not.toHaveBeenCalled();
  expect(fake.pg).not.toHaveBeenCalled();
});

test("SQL receives only the connector stream and cleans it up on completion", async () => {
  const stream = new PassThrough();
  fake.open.mockResolvedValue(stream);
  await testConnection(input, { siteScope: vpnScope });
  expect(fake.mysql).toHaveBeenCalledWith(input, "fixture", input.host, stream, {});
  expect(stream.destroyed).toBe(true);
  expect(fake.lookup).not.toHaveBeenCalled();
});

test("each site uses its own SQL credentials even when its private database target overlaps", async () => {
  const secondSite = { ...vpnSite, siteId: "33333333-3333-4333-8333-333333333333",
    connectorUrl: "https://second.example.test", tokenEnv: "WMS_SECOND_TOKEN", passwordEnv: "WMS_SECOND_PASSWORD" };
  vi.stubEnv(secondSite.tokenEnv, "second-site-token-".repeat(4));
  vi.stubEnv(secondSite.passwordEnv, "second-site-password");
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([vpnSite, secondSite]));
  await testConnection(input, { siteScope: vpnScope });
  const secondInput = { ...input, siteId: secondSite.siteId };
  await testConnection(secondInput, { siteScope: secondSite });
  expect(fake.mysql.mock.calls.map((call) => call[1])).toEqual(["fixture", "second-site-password"]);
  expect(fake.open.mock.calls.map((call) => call[1].siteId)).toEqual([vpnScope.siteId, secondSite.siteId]);
});

test("live reports use the same mandatory tunnel and clean it up after SQL failure", async () => {
  const stream = new PassThrough();
  fake.open.mockResolvedValue(stream);
  fake.report.mockRejectedValue(new Error("query failed"));
  await expect(executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }, undefined, { siteScope: vpnScope }))
    .rejects.toThrow("query failed");
  expect(fake.report.mock.calls[0].at(-2)).toBe(stream);
  expect(stream.destroyed).toBe(true);
  expect(fake.lookup).not.toHaveBeenCalled();
});

test("reports cannot bypass unavailable VPN by switching to a direct socket", async () => {
  fake.open.mockRejectedValue(new ConnectionFailure("VPN_NOT_READY", "VPN unavailable"));
  await expect(executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }, undefined, { siteScope: vpnScope }))
    .rejects.toMatchObject({ code: "VPN_NOT_READY" });
  expect(fake.report).not.toHaveBeenCalled();
  expect(fake.lookup).not.toHaveBeenCalled();
});

test("SQL and reports reject another client's or site's credentials without any connection", async () => {
  const foreignScope = { ...vpnScope, clientId: "33333333-3333-4333-8333-333333333333" };
  expect(await testConnection(input, { siteScope: foreignScope })).toMatchObject({ status: "error", code: "VPN_NOT_CONFIGURED" });
  expect(await testConnection({ ...input, siteId: foreignScope.clientId }, { siteScope: vpnScope }))
    .toMatchObject({ status: "error", code: "SECRET_MISMATCH" });
  await expect(executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }, undefined, { siteScope: foreignScope }))
    .rejects.toMatchObject({ code: "VPN_NOT_CONFIGURED" });
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.mysql).not.toHaveBeenCalled();
  expect(fake.report).not.toHaveBeenCalled();
  expect(fake.lookup).not.toHaveBeenCalled();
});

test("probes and reports receive only their site's SQL CA, never connector or global trust", async () => {
  const first = { ...vpnSite, caEnv: "WMS_HTTPS_CA", sqlCaEnv: "WMS_FIRST_SQL_CA" };
  const second = { ...first, siteId: "33333333-3333-4333-8333-333333333333",
    tokenEnv: "WMS_SECOND_TOKEN", sqlCaEnv: "WMS_SECOND_SQL_CA" };
  vi.stubEnv(second.tokenEnv, "second-site-token-".repeat(4));
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([first, second]));
  vi.stubEnv("WMS_HTTPS_CA", "connector CA");
  vi.stubEnv("WMS_MYSQL_CA_CERT", "global CA");
  vi.stubEnv(first.sqlCaEnv, "first SQL CA");
  vi.stubEnv(second.sqlCaEnv, "second SQL CA");
  for (const site of [first, second]) {
    await testConnection({ ...input, siteId: site.siteId }, { siteScope: site });
    await executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }, undefined, { siteScope: site });
  }
  expect(fake.mysql.mock.calls.map((call) => call.at(-1))).toEqual([{ ca: "first SQL CA" }, { ca: "second SQL CA" }]);
  expect(fake.report.mock.calls.map((call) => call.at(-1))).toEqual([{ ca: "first SQL CA" }, { ca: "second SQL CA" }]);
});

test.each([undefined, "", " \n "])("missing configured SQL CA (%j) blocks probes and reports before network access", async (ca) => {
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([{ ...vpnSite, sqlCaEnv: "WMS_MISSING_SQL_CA" }]));
  vi.stubEnv("WMS_MISSING_SQL_CA", ca);
  vi.stubEnv("WMS_MYSQL_CA_CERT", "must not fall back");
  expect(await testConnection(input, { siteScope: vpnScope }))
    .toMatchObject({ status: "error", code: "SQL_CA_NOT_CONFIGURED" });
  await expect(executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }, undefined, { siteScope: vpnScope }))
    .rejects.toMatchObject({ code: "SQL_CA_NOT_CONFIGURED" });
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.mysql).not.toHaveBeenCalled();
  expect(fake.report).not.toHaveBeenCalled();
  expect(fake.lookup).not.toHaveBeenCalled();
  // VPN readiness remains independent of SQL trust/password setup.
  expect((await testWmsVpn(input, vpnScope)).status).toBe("ready");
});

test("an omitted SQL CA uses system trust even with browser overrides and a global CA", async () => {
  vi.stubEnv("WMS_MYSQL_CA_CERT", "global CA");
  const untrusted = { ...input, ca: "browser CA", sqlCaEnv: "WMS_BROWSER_CA", rejectUnauthorized: false };
  await testConnection(untrusted, { siteScope: vpnScope });
  await executeApprovedMysqlReport(mapping, { clientKey: "client", siteKey: "site" }, undefined, { siteScope: vpnScope });
  expect(fake.mysql.mock.calls[0].at(-1)).toEqual({});
  expect(fake.report.mock.calls[0].at(-1)).toEqual({});
});

test.each(["OTHER_SQL_CA", "", "WMS_BAD-NAME"])("invalid SQL CA reference %j rejects registry", async (sqlCaEnv) => {
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([{ ...vpnSite, sqlCaEnv }]));
  expect(await testConnection(input, { siteScope: vpnScope }))
    .toMatchObject({ status: "error", code: "VPN_NOT_CONFIGURED" });
  expect(fake.open).not.toHaveBeenCalled();
});
