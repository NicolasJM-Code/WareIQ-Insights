import { z } from "zod";
import type { WmsConnectionInput } from "@workspace/api-zod";
import { ConnectionFailure } from "./wms-connection-error";

export type WmsSiteScope = { siteId: string; clientId: string };
const secretName = z.string().regex(/^WMS_[A-Z0-9_]+$/);
const entry = z.object({
  siteId: z.string().uuid(), clientId: z.string().uuid(),
  connectorUrl: z.string().url(), tokenEnv: secretName, caEnv: secretName.optional(),
  sqlCaEnv: secretName.optional(),
  passwordEnv: secretName,
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  port: z.number().int().min(1).max(65535),
  database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
  username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
}).strict();

/** Only server configuration supplies endpoints, approvals and secret references. */
export function siteVpnConfigs() {
  try {
    const entries = z.array(entry).min(1).max(256).parse(JSON.parse(process.env.WMS_OPENVPN_SITES ?? ""));
    if (new Set(entries.map((item) => item.siteId)).size !== entries.length) throw new Error();
    // Sharing a token between sites would weaken the connector's site binding.
    const tokens = entries.map((item) => process.env[item.tokenEnv]);
    if (tokens.some((token) => !token || token.length < 32 || /[\r\n]/.test(token)) ||
        new Set(tokens).size !== tokens.length) throw new Error();
    return entries;
  } catch {
    throw new ConnectionFailure("VPN_NOT_CONFIGURED", "An owner must configure a unique site-bound connector and credentials for this warehouse.");
  }
}

export function siteVpnConfig(scope?: WmsSiteScope) {
  if (!scope) throw new ConnectionFailure("VPN_SITE_REQUIRED", "Select an assigned warehouse before checking its VPN connection.");
  const config = siteVpnConfigs().find((item) => item.siteId === scope.siteId && item.clientId === scope.clientId);
  if (!config) throw new ConnectionFailure("VPN_NOT_CONFIGURED", "An owner must configure a site-bound connector for this warehouse.");
  return config;
}

export function siteVpnInput(scope?: WmsSiteScope): WmsConnectionInput {
  const config = siteVpnConfig(scope);
  return { engine: "mysql", host: config.host, port: config.port,
    database: config.database, schema: config.database, username: config.username,
    sslMode: "verify-full", queryTimeoutSec: 15, siteId: config.siteId };
}

/** SQL trust is site-owned, separate from connector HTTPS and direct-mode trust. */
export function siteVpnSqlTrust(scope?: WmsSiteScope): { ca?: string } {
  const config = siteVpnConfig(scope);
  if (!config.sqlCaEnv) return {}; // System roots only; never inherit the global bundle.
  const ca = process.env[config.sqlCaEnv];
  if (!ca?.trim())
    throw new ConnectionFailure("SQL_CA_NOT_CONFIGURED", "Configure this warehouse's SQL certificate authority securely on the server.");
  return { ca };
}

export function siteVpnPassword(input: WmsConnectionInput, scope?: WmsSiteScope, required = true) {
  const config = siteVpnConfig(scope);
  if (input.siteId !== config.siteId || input.host.toLowerCase() !== config.host.toLowerCase() ||
      input.port !== config.port || input.database !== config.database || input.username !== config.username)
    throw new ConnectionFailure("SECRET_MISMATCH", "These fields do not match this warehouse's server-approved destination. Credentials were not sent.");
  const password = process.env[config.passwordEnv];
  if (required && !password)
    throw new ConnectionFailure("PASSWORD_NOT_CONFIGURED", "Configure this warehouse's SQL password securely on the server.");
  return password ?? "";
}
