import { afterEach, beforeEach, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import { configureVpnSite, vpnScope } from "./fixtures/wms-vpn-sites";
const fake = vi.hoisted(() => ({
  userId: "admin" as string | null, user: vi.fn(), vpn: vi.fn(), sql: vi.fn(), access: vi.fn(), health: vi.fn(),
}));
vi.mock("../src/lib/wms-vpn-monitor", () => ({ warehouseVpnHealth: fake.health }));
vi.mock("../src/lib/reporting-access", async (original) => {
  const actual = await original<typeof import("../src/lib/reporting-access")>();
  return { ...actual, accessFor: fake.access };
});
vi.mock("@workspace/db", async () => ({ ...await import("@workspace/db/schema"), db: {} }));
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: fake.userId }),
  clerkClient: { users: { getUser: fake.user } },
}));
vi.mock("../src/lib/wms-connection", () => ({ testWmsVpn: fake.vpn, testConnection: fake.sql }));
import router from "../src/routes/wms";
const app = express().use(express.json()).use((req, _res, next) => {
  req.log = { info: vi.fn() } as unknown as typeof req.log;
  next();
}).use(router);
beforeEach(() => {
  vi.clearAllMocks(); fake.userId = "admin";
  configureVpnSite();
  fake.health.mockResolvedValue({ status: "unknown", checkedAt: null });
  fake.access.mockResolvedValue({
    actor: { platformAdmin: true }, member: { active: true },
    client: { id: vpnScope.clientId, active: true }, role: {},
    session: { sites: [{ id: vpnScope.siteId }] },
  });
  fake.user.mockResolvedValue({ publicMetadata: { role: "admin" } });
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "direct");
});
afterEach(() => vi.unstubAllEnvs());

test("all connection-path endpoints require sign-in", async () => {
  fake.userId = null;
  expect((await request(app).get("/wms/connection/network")).status).toBe(401);
  expect((await request(app).post("/wms/connection/vpn-test").send({})).status).toBe(401);
  expect((await request(app).post("/wms/connection/test").send({})).status).toBe(401);
  expect(fake.vpn).not.toHaveBeenCalled();
  expect(fake.sql).not.toHaveBeenCalled();
});

test("non-administrators and unverifiable roles cannot inspect or use the connector", async () => {
  fake.user.mockResolvedValue({ publicMetadata: { role: "supervisor" } });
  expect((await request(app).get("/wms/connection/network")).status).toBe(403);
  expect((await request(app).post("/wms/connection/vpn-test").send({})).status).toBe(403);
  fake.user.mockRejectedValue(new Error("provider unavailable"));
  expect((await request(app).get("/wms/connection/network")).status).toBe(503);
  expect(fake.vpn).not.toHaveBeenCalled();
});

test("administrators see the selected path but never the shared connector secret", async () => {
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "openvpn");
  vi.stubEnv("WMS_OPENVPN_CONNECTOR_URL", "https://gateway.example.test");
  vi.stubEnv("WMS_OPENVPN_CONNECTOR_TOKEN", "test-only-secret-".repeat(4));
  const response = await request(app).get("/wms/connection/network").query({ siteId: vpnScope.siteId });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toMatchObject({ path: "openvpn", configured: true });
  expect(fake.health).toHaveBeenCalledWith(vpnScope);
  expect(JSON.stringify(response.body)).not.toContain("test-only-secret");
});

test("fresh site membership is required for VPN checks, SQL tests and network configuration", async () => {
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "openvpn");
  const input = { engine: "mysql", siteId: vpnScope.siteId, host: "mysql.internal.example.test",
    port: 3306, database: "reporting", schema: "reporting", username: "reporter",
    sslMode: "verify-full", queryTimeoutSec: 15 };
  for (const access of [
    { member: { active: false }, client: { id: vpnScope.clientId, active: true }, role: {} },
    { member: { active: true }, client: { id: vpnScope.clientId, active: false }, role: {} },
    { member: { active: true }, client: { id: "foreign-client", active: true }, role: {} },
    { member: null, client: null, role: null },
  ]) {
    fake.access.mockResolvedValue({ ...access, actor: { platformAdmin: true }, session: { sites: [] } });
    expect((await request(app).get("/wms/connection/network").query({ siteId: vpnScope.siteId })).status).toBe(403);
    expect((await request(app).post("/wms/connection/vpn-test").send(input)).status).toBe(403);
    expect((await request(app).post("/wms/connection/test").send(input)).status).toBe(403);
  }
  expect(fake.vpn).not.toHaveBeenCalled();
  expect(fake.sql).not.toHaveBeenCalled();
  expect((await request(app).post("/wms/connection/test").send({ ...input, siteId: undefined })).status).toBe(400);
});

test("authorized site scope is server-derived and browser connector choices are rejected", async () => {
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "openvpn");
  const input = { engine: "mysql", siteId: vpnScope.siteId, host: "mysql.internal.example.test",
    port: 3306, database: "reporting", schema: "reporting", username: "reporter",
    sslMode: "verify-full", queryTimeoutSec: 15 };
  for (const extra of [{ clientId: "foreign" }, { connectorUrl: "https://attacker.example.test" },
    { tokenEnv: "WMS_OTHER_TOKEN" }, { password: "browser-password" }]) {
    expect((await request(app).post("/wms/connection/test").send({ ...input, ...extra })).status).toBe(400);
  }
  fake.sql.mockResolvedValue({ status: "error", code: "VPN_NOT_READY", message: "Unavailable",
    testedAt: new Date().toISOString() });
  expect((await request(app).post("/wms/connection/test").send(input)).status).toBe(200);
  expect(fake.sql).toHaveBeenCalledWith(input, { siteScope: vpnScope });
  expect(fake.access).toHaveBeenCalledTimes(5);
});

test("VPN endpoint rejects browser passwords and rate limits valid checks separately from SQL", async () => {
  const input = { engine: "mysql", host: "mysql.example.test", port: 3306, database: "reporting",
    schema: "reporting", username: "reporter", sslMode: "verify-full", queryTimeoutSec: 15 };
  expect((await request(app).post("/wms/connection/vpn-test").send({ ...input, password: "not-allowed" })).status).toBe(400);
  fake.vpn.mockResolvedValue({ status: "ready", code: "VPN_READY", message: "Verified", testedAt: new Date().toISOString() });
  expect((await request(app).post("/wms/connection/vpn-test").send(input)).status).toBe(200);
  expect((await request(app).post("/wms/connection/vpn-test").send(input)).status).toBe(429);
  expect(fake.vpn).toHaveBeenCalledOnce();
});
