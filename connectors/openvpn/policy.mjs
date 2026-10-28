import { BlockList, isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { lookup } from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const privateV4 = new BlockList();
privateV4.addSubnet("10.0.0.0", 8, "ipv4");
privateV4.addSubnet("172.16.0.0", 12, "ipv4");
privateV4.addSubnet("192.168.0.0", 16, "ipv4");
const hash = (value) => createHash("sha256").update(value).digest();

export function readConfig(env) {
  const port = Number(env.WAREIQ_DB_PORT);
  const listenPort = Number(env.WAREIQ_CONNECTOR_PORT || 8443);
  const address = env.WAREIQ_DB_ADDRESS;
  const host = env.WAREIQ_DB_HOST;
  const token = env.WAREIQ_CONNECTOR_TOKEN || "";
  const vpnInterface = env.WAREIQ_VPN_INTERFACE;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(env.WAREIQ_SITE_ID || "") || !uuid.test(env.WAREIQ_CLIENT_ID || ""))
    throw new Error("CONNECTOR_CONFIGURATION_INVALID");
  if (!host || host.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || isIP(host) ||
      isIP(address || "") !== 4 || !privateV4.check(address, "ipv4") ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535 ||
      !/^[A-Za-z0-9_.-]{1,15}$/.test(vpnInterface || "") ||
      !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(env.WAREIQ_DB_DATABASE || "") ||
      !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(env.WAREIQ_DB_USERNAME || "") ||
      token.length < 32 || /[\r\n]/.test(token) ||
      !env.WAREIQ_CONNECTOR_TLS_CERT_FILE || !env.WAREIQ_CONNECTOR_TLS_KEY_FILE)
    throw new Error("CONNECTOR_CONFIGURATION_INVALID");
  return {
    siteId: env.WAREIQ_SITE_ID, clientId: env.WAREIQ_CLIENT_ID,
    host, address, port, listenPort, vpnInterface,
    database: env.WAREIQ_DB_DATABASE, username: env.WAREIQ_DB_USERNAME,
    tokenHash: hash(`Bearer ${token}`),
    certFile: env.WAREIQ_CONNECTOR_TLS_CERT_FILE, keyFile: env.WAREIQ_CONNECTOR_TLS_KEY_FILE,
  };
}

export function authorized(req, config) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !timingSafeEqual(hash(authorization), config.tokenHash)) return false;
  return req.headers["x-wareiq-site"] === config.siteId &&
    req.headers["x-wareiq-client"] === config.clientId &&
    typeof req.headers["x-wareiq-host"] === "string" &&
    req.headers["x-wareiq-host"].toLowerCase() === config.host.toLowerCase() &&
    req.headers["x-wareiq-port"] === String(config.port) &&
    req.headers["x-wareiq-database"] === config.database &&
    req.headers["x-wareiq-username"] === config.username;
}

/** Check both tunnel presence and the actual kernel route, not merely an HTTP heartbeat. */
export async function assertVpnRoute(config, deps = {}) {
  const interfaces = (deps.interfaces || networkInterfaces)();
  if (!interfaces[config.vpnInterface]?.some((entry) => !entry.internal && entry.family === "IPv4"))
    throw new Error("VPN_NOT_READY");
  let timer;
  try {
    const addresses = await Promise.race([
      (deps.lookup || lookup)(config.host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("VPN_NOT_READY")), 3000); }),
    ]);
    if (!addresses.length || addresses.some(({ address }) => address !== config.address))
      throw new Error("VPN_NOT_READY");
    const output = deps.route
      ? await deps.route(config.address)
      : (await execute("ip", ["-j", "route", "get", config.address], { timeout: 3000, maxBuffer: 8192 })).stdout;
    const routes = JSON.parse(output);
    if (!Array.isArray(routes) || routes.length !== 1 ||
        routes[0].dev !== config.vpnInterface ||
        (routes[0].type && routes[0].type !== "unicast"))
      throw new Error("VPN_NOT_READY");
  } finally { clearTimeout(timer); }
}
