import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { configureVpnSite, vpnScope, vpnSite, vpnToken } from "./fixtures/wms-vpn-sites";

const fake = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: fake.request } }));
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
import { checkOpenVpn, getWmsNetworkConfig, mysqlConnectionPath, openVpnMysqlStream } from "../src/lib/wms-openvpn";

const input = { siteId: vpnScope.siteId, engine: "mysql" as const, host: "mysql.internal.example.test", port: 3306,
  database: "reporting", schema: "reporting", username: "reporter",
  sslMode: "verify-full" as const, queryTimeoutSec: 15 };
const token = vpnToken;

beforeEach(() => {
  vi.clearAllMocks();
  configureVpnSite();
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "openvpn");
  vi.stubEnv("WMS_OPENVPN_CONNECTOR_URL", "https://gateway.example.test:8443");
  vi.stubEnv("WMS_OPENVPN_CONNECTOR_TOKEN", token);
  fake.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  fake.request.mockImplementation((options: { method: string }) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = vi.fn();
    req.end = () => queueMicrotask(() => {
      if (options.method === "CONNECT") req.emit("connect", { statusCode: 200 }, new PassThrough(), Buffer.alloc(0));
      else {
        const res = Object.assign(new PassThrough(), { statusCode: 200 });
        req.emit("response", res);
        res.end('{"vpn":"ready"}');
      }
    });
    return req;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

test("readiness is authenticated, DNS-pinned HTTPS and sends no SQL password", async () => {
  await checkOpenVpn(input, vpnScope);
  const options = fake.request.mock.calls[0][0];
  expect(options).toMatchObject({ hostname: "8.8.8.8", servername: "gateway.example.test",
    port: 8443, method: "GET", path: "/v1/status", rejectUnauthorized: true, agent: false });
  expect(options.headers).toMatchObject({ authorization: `Bearer ${token}`,
    "x-wareiq-host": input.host, "x-wareiq-port": "3306",
    "x-wareiq-database": input.database, "x-wareiq-username": input.username });
  expect(options.headers).not.toHaveProperty("password");
  expect(options.checkServerIdentity).toBeTypeOf("function");
  expect(JSON.stringify(getWmsNetworkConfig(vpnScope))).not.toContain(token);
});

test("every SQL stream checks VPN first, then requests only the fixed MySQL tunnel", async () => {
  const stream = await openVpnMysqlStream(input, vpnScope);
  expect(fake.request.mock.calls.map(([options]) => [options.method, options.path]))
    .toEqual([["GET", "/v1/status"], ["CONNECT", "/v1/mysql"]]);
  stream.destroy();
});

test.each([
  "http://gateway.example.test", "https://user:pass@gateway.example.test",
  "https://8.8.8.8", "https://gateway.example.test/other",
  "https://gateway.example.test?redirect=elsewhere",
])("invalid connector configuration is rejected without outbound traffic: %s", async (url) => {
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([{ ...vpnSite, connectorUrl: url }]));
  expect(getWmsNetworkConfig(vpnScope).configured).toBe(false);
  await expect(checkOpenVpn(input, vpnScope)).rejects.toMatchObject({ code: "VPN_NOT_CONFIGURED" });
  expect(fake.request).not.toHaveBeenCalled();
});

test.each([
  [{ address: "127.0.0.1", family: 4 }],
  [{ address: "10.0.0.10", family: 4 }],
  [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }],
])("nonpublic or mixed gateway DNS is rejected before credentials are sent", async (addresses) => {
  fake.lookup.mockResolvedValue(addresses);
  await expect(checkOpenVpn(input, vpnScope)).rejects.toMatchObject({ code: "VPN_NOT_READY" });
  expect(fake.request).not.toHaveBeenCalled();
});

test("failed readiness never opens a SQL tunnel or reflects untrusted response text", async () => {
  fake.request.mockImplementation(() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = vi.fn();
    req.end = () => queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), { statusCode: 503 });
      req.emit("response", res);
      res.end("sensitive upstream failure");
    });
    return req;
  });
  await expect(openVpnMysqlStream(input, vpnScope)).rejects.toMatchObject({ code: "VPN_NOT_READY" });
  expect(fake.request).toHaveBeenCalledTimes(1);
  expect(fake.request.mock.calls[0][0].method).toBe("GET");
});

test("an invalid path cannot silently fall back to direct access", async () => {
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "typo");
  expect(() => mysqlConnectionPath()).toThrow();
  expect(getWmsNetworkConfig()).toMatchObject({ path: "openvpn", configured: false });
  await expect(checkOpenVpn(input, vpnScope)).rejects.toMatchObject({ code: "VPN_CONFIGURATION_INVALID" });
  expect(fake.request).not.toHaveBeenCalled();
});

test("a stalled connector request times out and destroys transport without exposing secrets", async () => {
  vi.useFakeTimers();
  const destroy = vi.fn();
  fake.request.mockReturnValue(Object.assign(new EventEmitter(), { end: vi.fn(), destroy }));
  const check = expect(checkOpenVpn(input, vpnScope)).rejects.toMatchObject({ code: "VPN_NOT_READY" });
  await vi.advanceTimersByTimeAsync(8000);
  await check;
  expect(destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("gateway DNS has a finite timeout and never sends credentials after it expires", async () => {
  vi.useFakeTimers();
  fake.lookup.mockReturnValue(new Promise(() => {}));
  const check = expect(checkOpenVpn(input, vpnScope)).rejects.toMatchObject({ code: "VPN_NOT_READY" });
  await vi.advanceTimersByTimeAsync(5000);
  await check;
  expect(fake.request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("two sites select separate connectors and tokens even with identical private SQL targets", async () => {
  const other = { ...vpnSite, siteId: "33333333-3333-4333-8333-333333333333",
    connectorUrl: "https://second.example.test", tokenEnv: "WMS_OTHER_TOKEN", passwordEnv: "WMS_OTHER_PASSWORD" };
  vi.stubEnv(other.tokenEnv, "other-site-token-".repeat(4));
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([vpnSite, other]));
  await checkOpenVpn(input, vpnScope);
  await checkOpenVpn({ ...input, siteId: other.siteId }, other);
  expect(fake.request.mock.calls.map(([options]) => options.servername))
    .toEqual(["gateway.example.test", "second.example.test"]);
  expect(fake.request.mock.calls[1][0].headers).toMatchObject({
    authorization: `Bearer ${process.env[other.tokenEnv]}`, "x-wareiq-site": other.siteId,
    "x-wareiq-client": other.clientId,
  });
});

test("cross-client, wrong-site, missing scope and duplicate site bindings fail before DNS or HTTPS", async () => {
  for (const scope of [undefined, { ...vpnScope, clientId: "33333333-3333-4333-8333-333333333333" },
    { ...vpnScope, siteId: "33333333-3333-4333-8333-333333333333" }])
    await expect(checkOpenVpn(input, scope)).rejects.toBeDefined();
  await expect(checkOpenVpn({ ...input, siteId: "33333333-3333-4333-8333-333333333333" }, vpnScope))
    .rejects.toMatchObject({ code: "SECRET_MISMATCH" });
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([vpnSite, vpnSite]));
  await expect(checkOpenVpn(input, vpnScope)).rejects.toBeDefined();
  expect(fake.lookup).not.toHaveBeenCalled();
  expect(fake.request).not.toHaveBeenCalled();
});
