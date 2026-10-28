import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const fake = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: fake.request } }));
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
import { checkOpenVpn, getWmsNetworkConfig, mysqlConnectionPath, openVpnMysqlStream } from "../src/lib/wms-openvpn";

const input = { engine: "mysql" as const, host: "mysql.internal.example.test", port: 3306,
  database: "reporting", schema: "reporting", username: "reporter",
  sslMode: "verify-full" as const, queryTimeoutSec: 15 };
const token = "connector-test-only-".repeat(4);

beforeEach(() => {
  vi.clearAllMocks();
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
afterEach(() => vi.unstubAllEnvs());

test("readiness is authenticated, DNS-pinned HTTPS and sends no SQL password", async () => {
  await checkOpenVpn(input);
  const options = fake.request.mock.calls[0][0];
  expect(options).toMatchObject({ hostname: "8.8.8.8", servername: "gateway.example.test",
    port: 8443, method: "GET", path: "/v1/status", rejectUnauthorized: true, agent: false });
  expect(options.headers).toMatchObject({ authorization: `Bearer ${token}`,
    "x-wareiq-host": input.host, "x-wareiq-port": "3306",
    "x-wareiq-database": input.database, "x-wareiq-username": input.username });
  expect(options.headers).not.toHaveProperty("password");
  expect(options.checkServerIdentity).toBeTypeOf("function");
  expect(JSON.stringify(getWmsNetworkConfig())).not.toContain(token);
});

test("every SQL stream checks VPN first, then requests only the fixed MySQL tunnel", async () => {
  const stream = await openVpnMysqlStream(input);
  expect(fake.request.mock.calls.map(([options]) => [options.method, options.path]))
    .toEqual([["GET", "/v1/status"], ["CONNECT", "/v1/mysql"]]);
  stream.destroy();
});

test.each([
  "http://gateway.example.test", "https://user:pass@gateway.example.test",
  "https://8.8.8.8", "https://gateway.example.test/other",
  "https://gateway.example.test?redirect=elsewhere",
])("invalid connector configuration is rejected without outbound traffic: %s", async (url) => {
  vi.stubEnv("WMS_OPENVPN_CONNECTOR_URL", url);
  expect(getWmsNetworkConfig().configured).toBe(false);
  await expect(checkOpenVpn(input)).rejects.toMatchObject({ code: "VPN_NOT_CONFIGURED" });
  expect(fake.request).not.toHaveBeenCalled();
});

test.each([
  [{ address: "127.0.0.1", family: 4 }],
  [{ address: "10.0.0.10", family: 4 }],
  [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }],
])("nonpublic or mixed gateway DNS is rejected before credentials are sent", async (addresses) => {
  fake.lookup.mockResolvedValue(addresses);
  await expect(checkOpenVpn(input)).rejects.toMatchObject({ code: "VPN_NOT_READY" });
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
  await expect(openVpnMysqlStream(input)).rejects.toMatchObject({ code: "VPN_NOT_READY" });
  expect(fake.request).toHaveBeenCalledTimes(1);
  expect(fake.request.mock.calls[0][0].method).toBe("GET");
});

test("an invalid path cannot silently fall back to direct access", async () => {
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "typo");
  expect(() => mysqlConnectionPath()).toThrow();
  expect(getWmsNetworkConfig()).toMatchObject({ path: "openvpn", configured: false });
  await expect(checkOpenVpn(input)).rejects.toMatchObject({ code: "VPN_CONFIGURATION_INVALID" });
  expect(fake.request).not.toHaveBeenCalled();
});
