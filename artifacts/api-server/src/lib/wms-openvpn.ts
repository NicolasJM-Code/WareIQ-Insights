import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { Duplex } from "node:stream";
import ipaddr from "ipaddr.js";
import type { WmsConnectionInput, WmsNetworkConfig } from "@workspace/api-zod";
import { ConnectionFailure } from "./wms-connection-error";

const failure = () => new ConnectionFailure("VPN_NOT_READY",
  "The OpenVPN connector is unavailable, its destination approval differs, or its VPN route is not ready. SQL was not started.");

export function mysqlConnectionPath(): "direct" | "openvpn" {
  const path = process.env.WMS_MYSQL_CONNECTION_PATH ?? "direct";
  if (path !== "direct" && path !== "openvpn")
    throw new ConnectionFailure("VPN_CONFIGURATION_INVALID", "The server connection path must be direct or openvpn.");
  return path;
}

function connectorConfig() {
  try {
    const url = new URL(process.env.WMS_OPENVPN_CONNECTOR_URL ?? "");
    const token = process.env.WMS_OPENVPN_CONNECTOR_TOKEN ?? "";
    if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname) ||
        url.pathname !== "/" || url.search || url.hash || token.length < 32 || /[\r\n]/.test(token))
      throw new Error();
    return { url, token, ca: process.env.WMS_OPENVPN_CONNECTOR_CA_CERT };
  } catch {
    throw new ConnectionFailure("VPN_NOT_CONFIGURED",
      "An owner must install the connector on the OpenVPN server and configure its HTTPS URL and secret token on the WareIQ server.");
  }
}

export function getWmsNetworkConfig(): WmsNetworkConfig {
  try {
    const path = mysqlConnectionPath();
    if (path === "direct") return { path, configured: true,
      message: "Direct MySQL connection. To require VPN first, configure the OpenVPN connector and select openvpn in server configuration." };
    connectorConfig();
    return { path, configured: true, message: "OpenVPN connector → verified TLS MySQL. Check VPN readiness before the SQL test." };
  } catch (error) {
    return { path: "openvpn", configured: false,
      message: error instanceof ConnectionFailure ? error.message : "The OpenVPN connector is not configured." };
  }
}

async function pinnedGateway(host: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), 5000); }),
    ]);
    if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast"))
      throw failure();
    return ipaddr.process(addresses[0].address).toString();
  } catch { throw failure(); }
  finally { clearTimeout(timer); }
}

/** HTTPS transport auth is separate from MySQL auth. No database password is sent in these headers. */
function targetHeaders(input: WmsConnectionInput, token: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-wareiq-host": input.host,
    "x-wareiq-port": String(input.port),
    "x-wareiq-database": input.database,
    "x-wareiq-username": input.username,
  };
}

async function connectorRequest(input: WmsConnectionInput, tunnel: boolean): Promise<Duplex | undefined> {
  if (mysqlConnectionPath() !== "openvpn")
    throw new ConnectionFailure("VPN_NOT_ENABLED", "The server is using the direct connection path. An owner must enable the OpenVPN connector path first.");
  const config = connectorConfig();
  const address = await pinnedGateway(config.url.hostname);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.request({
      hostname: address, port: Number(config.url.port || 443),
      servername: config.url.hostname, rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(config.url.hostname, certificate),
      ...(config.ca ? { ca: config.ca } : {}),
      method: tunnel ? "CONNECT" : "GET",
      path: tunnel ? "/v1/mysql" : "/v1/status",
      headers: { ...targetHeaders(input, config.token), host: config.url.host },
      agent: false, maxHeaderSize: 8192,
    });
    const timer = setTimeout(() => { req.destroy(); finish(failure()); }, 8000);
    function finish(error?: Error, socket?: Duplex) {
      if (settled) { socket?.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(socket);
    }
    req.on("error", () => finish(failure()));
    req.on("response", (res) => {
      if (tunnel || res.statusCode !== 200) { res.destroy(); finish(failure()); return; }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        data += chunk;
        if (Buffer.byteLength(data) > 4096) { res.destroy(); finish(failure()); }
      });
      res.on("error", () => finish(failure()));
      res.on("aborted", () => finish(failure()));
      res.on("end", () => {
        try {
          if (JSON.parse(data).vpn !== "ready") throw failure();
          finish();
        } catch { finish(failure()); }
      });
    });
    req.on("connect", (res, socket, head) => {
      if (!tunnel || res.statusCode !== 200) { socket.destroy(); finish(failure()); return; }
      socket.on("error", () => {}); // mysql2 adds its own handler immediately after handoff.
      socket.pause();
      if (head.length) socket.unshift(head);
      // mysql2 installs listeners synchronously after this promise resolves.
      setImmediate(() => { if (!socket.destroyed) socket.resume(); });
      finish(undefined, socket);
    });
    req.end();
  });
}

export async function checkOpenVpn(input: WmsConnectionInput): Promise<void> {
  await connectorRequest(input, false);
}

export async function openVpnMysqlStream(input: WmsConnectionInput): Promise<Duplex> {
  await checkOpenVpn(input);
  // The connector rechecks the route immediately before opening this tunnel.
  return (await connectorRequest(input, true))!;
}
