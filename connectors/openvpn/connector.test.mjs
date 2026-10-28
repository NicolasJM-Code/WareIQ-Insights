import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer as tlsServer, connect as tlsConnect } from "node:tls";
import { createConnection, Socket } from "node:net";
import https from "node:https";
import { once } from "node:events";
import { readConfig, authorized, assertVpnRoute } from "./policy.mjs";
import { createConnector } from "./server.mjs";

const token = "not-a-real-secret-".repeat(4);
const env = {
  WAREIQ_SITE_ID: "11111111-1111-4111-8111-111111111111",
  WAREIQ_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  WAREIQ_CONNECTOR_TOKEN: token, WAREIQ_CONNECTOR_TLS_CERT_FILE: "/unused/cert",
  WAREIQ_CONNECTOR_TLS_KEY_FILE: "/unused/key", WAREIQ_VPN_INTERFACE: "tun0",
  WAREIQ_DB_HOST: "mysql.internal.example.test", WAREIQ_DB_ADDRESS: "10.40.0.10",
  WAREIQ_DB_PORT: "3306", WAREIQ_DB_DATABASE: "reporting", WAREIQ_DB_USERNAME: "reporter",
};
const headers = {
  "x-wareiq-site": env.WAREIQ_SITE_ID, "x-wareiq-client": env.WAREIQ_CLIENT_ID,
  authorization: `Bearer ${token}`, "x-wareiq-host": env.WAREIQ_DB_HOST,
  "x-wareiq-port": "3306", "x-wareiq-database": "reporting", "x-wareiq-username": "reporter",
};

test("connector accepts only a private pinned target and exact authenticated destination", () => {
  const config = readConfig(env);
  assert.equal(authorized({ headers }, config), true);
  for (const invalid of [
    { ...headers, "x-wareiq-site": "33333333-3333-4333-8333-333333333333" },
    { ...headers, "x-wareiq-client": "33333333-3333-4333-8333-333333333333" },
    { ...headers, authorization: "Bearer wrong" },
    { ...headers, "x-wareiq-host": "other.example.test" },
    { ...headers, "x-wareiq-host": ["malformed"] },
    { ...headers, "x-wareiq-port": "5005" },
    { ...headers, "x-wareiq-database": "other" },
    { ...headers, "x-wareiq-username": "root" },
  ]) assert.equal(authorized({ headers: invalid }, config), false);
  for (const address of ["8.8.8.8", "127.0.0.1", "169.254.169.254", "::1"])
    assert.throws(() => readConfig({ ...env, WAREIQ_DB_ADDRESS: address }));
});

test("readiness requires the VPN interface, exclusive pinned DNS and actual kernel route", async () => {
  const config = readConfig(env);
  const valid = {
    interfaces: () => ({ tun0: [{ internal: false, family: "IPv4" }] }),
    lookup: async () => [{ address: "10.40.0.10", family: 4 }],
    route: async () => '[{"dev":"tun0"}]',
  };
  await assertVpnRoute(config, valid);
  for (const change of [
    { interfaces: () => ({}) },
    { route: async () => '[{"dev":"eth0"}]' },
    { route: async () => '[{"dev":"tun0","type":"blackhole"}]' },
    { lookup: async () => [{ address: "10.40.0.10" }, { address: "8.8.8.8" }] },
  ]) await assert.rejects(assertVpnRoute(config, { ...valid, ...change }));
});

test("real HTTPS CONNECT carries nested verified TLS and drops the tunnel when VPN fails",
  { timeout: 15000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wareiq-connector-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const certFile = join(dir, "cert.pem"), keyFile = join(dir, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=gateway.example.test",
      "-addext", "subjectAltName=DNS:gateway.example.test,DNS:mysql.internal.example.test",
      "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
    const cert = readFileSync(certFile), key = readFileSync(keyFile);
    const sockets = new Set();
    const track = (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
    let sqlTlsSessions = 0;
    const db = tlsServer({ cert, key }, (socket) => {
      sqlTlsSessions += 1;
      socket.on("error", () => {});
      socket.on("data", (chunk) => socket.write(chunk));
    });
    db.on("connection", track);
    await new Promise((resolve) => db.listen(0, "127.0.0.1", resolve));
    let routeReady = true, dialCount = 0, routeChecks = 0;
    let routeWait;
    let stalledSocket;
    let stallTcp = false;
    const connector = createConnector(readConfig({
      ...env, WAREIQ_CONNECTOR_TLS_CERT_FILE: certFile, WAREIQ_CONNECTOR_TLS_KEY_FILE: keyFile,
    }), {
      statusTimeoutMs: 100,
      checkRoute: async () => {
        routeChecks += 1;
        if (routeWait) await routeWait;
        if (!routeReady) throw new Error("VPN_NOT_READY");
      },
      connect: (options) => {
        assert.deepEqual(options, { host: "10.40.0.10", port: 3306 });
        dialCount += 1;
        if (stallTcp) return (stalledSocket = new Socket());
        return createConnection({ host: "127.0.0.1", port: db.address().port });
      },
    });
    connector.on("connection", track);
    await new Promise((resolve) => connector.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise((resolve) => connector.close(resolve)),
        new Promise((resolve) => db.close(resolve))]);
    });
    const requestOptions = { hostname: "127.0.0.1", port: connector.address().port,
      servername: "gateway.example.test", ca: cert, rejectUnauthorized: true, agent: false };
    const status = (requestHeaders) => new Promise((resolve, reject) => {
      const req = https.request({ ...requestOptions, path: "/v1/status", headers: requestHeaders }, (res) => {
        res.resume(); res.once("end", () => resolve(res.statusCode));
      });
      req.once("error", reject); req.end();
    });
    assert.equal(await status({ ...headers, authorization: "Bearer invalid" }), 403);
    assert.equal(await status({ ...headers, "x-wareiq-site": "wrong-site" }), 403);
    assert.equal(await status({ ...headers, "x-wareiq-client": "wrong-client" }), 403);
    assert.equal(dialCount, 0, "unauthorised site/client must not probe the database");
    assert.equal(await status(headers), 200);
    assert.equal(dialCount, 1, "readiness probes the pinned database TCP port");
    assert.equal(sqlTlsSessions, 0, "VPN readiness must not attempt a SQL TLS handshake or login");
    const tunnel = await new Promise((resolve, reject) => {
      const req = https.request({ ...requestOptions, method: "CONNECT", path: "/v1/mysql", headers });
      req.once("error", reject);
      req.once("connect", (res, socket, head) => {
        if (res.statusCode !== 200) { socket.destroy(); reject(new Error("CONNECT failed")); return; }
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.end();
    });
    tunnel.on("error", () => {});
    const nested = tlsConnect({ socket: tunnel, servername: env.WAREIQ_DB_HOST,
      ca: cert, rejectUnauthorized: true });
    nested.on("error", () => {});
    await once(nested, "secureConnect");
    const reply = once(nested, "data");
    nested.write("read-only-transport-probe");
    assert.equal((await reply)[0].toString(), "read-only-transport-probe");
    assert.equal(dialCount, 2);
    const closed = new Promise((resolve) => nested.once("close", resolve));
    routeReady = false;
    assert.equal(await status(headers), 503);
    await closed;
    assert.equal(nested.destroyed, true, "a lost VPN route must close the existing tunnel");

    // A stalled route check cannot hold HTTP requests indefinitely or fan out
    // additional readiness work. No SQL or external network is used.
    routeReady = true;
    let releaseRoute;
    routeWait = new Promise((resolve) => { releaseRoute = resolve; });
    const checksBefore = routeChecks;
    assert.deepEqual(await Promise.all([status(headers), status(headers), status(headers)]), [503, 503, 503]);
    assert.equal(await status(headers), 503);
    assert.equal(routeChecks, checksBefore + 1, "only one underlying route check may run");
    releaseRoute();
    routeWait = undefined;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await status(headers), 200, "readiness recovers after the route check returns");

    stallTcp = true;
    assert.equal(await status(headers), 503, "a stalled TCP probe never reports ready");
    assert.equal(await status(headers), 503);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(stalledSocket.destroyed, true, "the TCP probe closes its socket at its deadline");
    stallTcp = false;
    assert.equal(await status(headers), 200);
  });
