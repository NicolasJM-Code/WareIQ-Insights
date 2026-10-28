// Run on the existing Linux OpenVPN-connected server, NOT in the Replit runtime.
// No third-party Node dependencies. MySQL TLS remains end-to-end through CONNECT.
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readConfig, authorized, assertVpnRoute } from "./policy.mjs";

export function createConnector(config, dependencies = {}) {
  const checkRoute = dependencies.checkRoute || assertVpnRoute;
  const dial = dependencies.connect || createConnection;
  const probe = () => new Promise((resolve, reject) => {
    const socket = dial({ host: config.address, port: config.port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("VPN_NOT_READY")); }, 2000);
    socket.once("error", () => { clearTimeout(timer); reject(new Error("VPN_NOT_READY")); });
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
  });
  const server = createServer({
    cert: readFileSync(config.certFile), key: readFileSync(config.keyFile),
    minVersion: "TLSv1.2", handshakeTimeout: 8000,
  });
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxHeadersCount = 20;
  let active = 0;
  server.on("request", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "close");
    if (!authorized(req, config)) { res.writeHead(403).end(); return; }
    if (req.method !== "GET" || req.url !== "/v1/status") { res.writeHead(404).end(); return; }
    try {
      await checkRoute(config);
      // TCP reachability through the verified VPN route, without a SQL login.
      await probe();
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"vpn":"ready"}');
    } catch { res.writeHead(503).end(); }
  });
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    const refuse = (status) => {
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      setTimeout(() => client.destroy(), 1000).unref();
    };
    if (!authorized(req, config)) { refuse("403 Forbidden"); return; }
    if (req.url !== "/v1/mysql" || head.length) { refuse("400 Bad Request"); return; }
    if (active >= 10) { refuse("503 Service Unavailable"); return; }
    active += 1;
    let db;
    let monitor;
    let lifetime;
    let connectTimer;
    let checking = false;
    client.once("close", () => {
      active -= 1;
      clearInterval(monitor); clearTimeout(lifetime); clearTimeout(connectTimer);
      db?.destroy();
    });
    try {
      await checkRoute(config);
      if (client.destroyed) return;
      db = dial({ host: config.address, port: config.port });
      connectTimer = setTimeout(() => { db.destroy(); client.destroy(); }, 8000);
      db.on("error", () => client.destroy());
      db.once("close", () => client.destroy());
      db.once("connect", () => {
        clearTimeout(connectTimer);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(db); db.pipe(client);
      });
      client.setTimeout(20000, () => client.destroy());
      lifetime = setTimeout(() => client.destroy(), 120000);
      monitor = setInterval(async () => {
        if (checking) return;
        checking = true;
        try { await checkRoute(config); } catch { client.destroy(); }
        finally { checking = false; }
      }, 2000);
    } catch { refuse("503 Service Unavailable"); }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig(process.env);
    const server = createConnector(config);
    server.on("error", () => { process.stderr.write("CONNECTOR_START_FAILED\n"); process.exit(1); });
    server.listen(config.listenPort, "0.0.0.0", () => process.stdout.write("WAREIQ_CONNECTOR_LISTENING\n"));
  } catch { process.stderr.write("CONNECTOR_CONFIGURATION_INVALID\n"); process.exit(1); }
}
