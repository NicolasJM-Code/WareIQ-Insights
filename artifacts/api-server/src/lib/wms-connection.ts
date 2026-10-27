import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity as pgServerIdentity } from "node:tls";
import pg from "pg";
import ipaddr from "ipaddr.js";
import type { WmsConnectionInput, WmsConnectionResult } from "@workspace/api-zod";

export class ConnectionFailure extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Never include the driver message, query, config, or cause in a response/log. */
export function safeConnectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof ConnectionFailure) return error;
  const code = (error as { code?: string })?.code;
  if (code === "28P01" || code === "28000")
    return new ConnectionFailure("AUTHENTICATION_FAILED", "PostgreSQL rejected the reporting username or server-side password.");
  if (code === "3D000")
    return new ConnectionFailure("DATABASE_NOT_FOUND", "The database name was not found. Check the Database name field.");
  if (code === "42501")
    return new ConnectionFailure("ACCESS_DENIED", "The reporting account cannot access the selected database or schema.");
  if (code === "3F000")
    return new ConnectionFailure("SCHEMA_NOT_FOUND", "The selected reporting schema does not exist. Check the Database schema field.");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return new ConnectionFailure("HOST_NOT_FOUND", "The database hostname could not be resolved.");
  if (code === "ECONNREFUSED")
    return new ConnectionFailure("CONNECTION_REFUSED", "The database refused the connection. Check the PostgreSQL port and firewall.");
  if (code?.includes("CERT") || code?.includes("TLS") || code?.includes("SSL") ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      /ssl|tls|certificate/i.test(String((error as Error)?.message)))
    return new ConnectionFailure("TLS_FAILED", "Verified TLS could not be established. Check the database certificate and hostname; a private CA must be configured server-side.");
  if (code === "57014" || code === "ETIMEDOUT" ||
      /timeout|timed out/i.test(String((error as Error)?.message)))
    return new ConnectionFailure("TIMEOUT", "The connection or query timed out. Check network access and the PostgreSQL port.");
  return new ConnectionFailure("CONNECTION_FAILED", "The database connection failed. Check the server address, port, database and network access.");
}

/** Credentials may only reach a destination approved in server configuration.
 * Administrator form fields are untrusted destinations, not an allowlist. */
function reportingPassword(input: WmsConnectionInput): string {
  type Destination = { host: string; port: number; database: string; username: string };
  let urlDestination: (Destination & { password: string }) | undefined;
  try {
    const url = new URL(process.env.WMS_DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    const username = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!username || !database) throw new Error();
    urlDestination = { host: url.hostname, port: Number(url.port || 5432),
      database, username, password: decodeURIComponent(url.password) };
  } catch { /* An invalid URL is never an approved destination. */ }
  const password = process.env.WMS_PGPASSWORD || urlDestination?.password;
  if (!password) throw new ConnectionFailure("PASSWORD_NOT_CONFIGURED",
    "Configure WMS credentials securely on the server. Passwords are never stored in this browser.");
  const configured = [process.env.WMS_APPROVED_HOST, process.env.WMS_APPROVED_PORT,
    process.env.WMS_APPROVED_DATABASE, process.env.WMS_APPROVED_USERNAME];
  let approved: Destination | undefined;
  if (configured.some((value) => value !== undefined)) {
    const [host, rawPort, database, username] = configured;
    const port = Number(rawPort);
    if (!host || !database || !username || !rawPort || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new ConnectionFailure("DESTINATION_NOT_CONFIGURED",
        "The approved WMS destination is incomplete. An owner must configure its host, port, database and username on the server.");
    approved = { host, port, database, username };
  } else {
    // A server-held PostgreSQL URL can itself bind either password source.
    approved = urlDestination;
  }
  if (!approved) throw new ConnectionFailure("DESTINATION_NOT_CONFIGURED",
    "An owner must approve the WMS host, port, database and username on the server before testing a connection.");
  const matches = (destination: Destination) =>
    destination.host.toLowerCase() === input.host.toLowerCase() &&
    destination.port === input.port && destination.database === input.database &&
    destination.username === input.username;
  if (!matches(approved) || (!process.env.WMS_PGPASSWORD && (!urlDestination || !matches(urlDestination))))
    throw new ConnectionFailure("SECRET_MISMATCH",
      "These fields do not match the server-approved WMS destination. Credentials were not sent. Ask an owner to approve any destination change securely.");
  return password;
}

async function publicAddress(host: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConnectionFailure("TIMEOUT", "Hostname lookup timed out.")), 5000);
      }),
    ]);
    // Pin the resolved address to avoid DNS rebinding / internal network probes.
    if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast"))
      throw new ConnectionFailure("HOST_NOT_ALLOWED", "This test supports publicly routable database addresses only. Private networks require a separately approved server-side network configuration.");
    return addresses[0].address;
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(input: WmsConnectionInput): Promise<WmsConnectionResult> {
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  try {
    const password = reportingPassword(input);
    const address = await publicAddress(input.host);
    const timeout = Math.min(input.queryTimeoutSec * 1000, 15000);
    pool = new pg.Pool({
      host: address, port: input.port, database: input.database, user: input.username, password,
      ssl: {
        rejectUnauthorized: true,
        ...(isIP(input.host) ? {} : { servername: input.host }),
        ...(process.env.WMS_CA_CERT ? { ca: process.env.WMS_CA_CERT } : {}),
        // When dialing a pinned IP, explicitly verify the original hostname/IP.
        checkServerIdentity: (_hostname, certificate) => pgServerIdentity(input.host, certificate),
      },
      max: 1, connectionTimeoutMillis: 8000, idleTimeoutMillis: 1000,
      statement_timeout: timeout, query_timeout: timeout + 1000,
      options: "-c default_transaction_read_only=on -c search_path=pg_catalog",
      application_name: "WareIQ-connection-test",
    });
    // A pool error must not leak driver details or become an unhandled event.
    pool.on("error", () => {});
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    const access = await client.query(`
      SELECT
        has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
          AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS privileged,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
            OR has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES'))) AS writable,
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
          AND nspname <> 'information_schema'
          AND has_schema_privilege(current_user, oid, 'CREATE')) AS can_create,
        EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = $1) AS has_views
    `, [input.schema]);
    const row = access.rows[0];
    if (!row?.schema_usage)
      throw new ConnectionFailure("SCHEMA_ACCESS_DENIED", "The schema does not exist or the reporting account lacks USAGE access.");
    if (row.privileged || row.writable || row.can_create)
      throw new ConnectionFailure("READ_ONLY_ROLE_REQUIRED", "Connection reached PostgreSQL, but this account has elevated or write permissions. Use a dedicated SELECT-only reporting account.");
    if (!row.has_views)
      throw new ConnectionFailure("REPORTING_VIEWS_REQUIRED", "Connection reached PostgreSQL, but no accessible reporting views were found in this schema. Approved views and mappings are required.");
    await client.query("ROLLBACK");
    const at = new Date().toISOString();
    return { status: "connected", code: "CONNECTED", testedAt: at, lastSuccessfulAt: at,
      message: "Verified TLS, authentication, read-only account checks and schema access succeeded. No warehouse records were read. Reports remain sample data until source views are approved and mapped." };
  } catch (error) {
    const safe = safeConnectionFailure(error);
    return { status: "error", code: safe.code, message: safe.message, testedAt: new Date().toISOString() };
  } finally {
    client?.release(true);
    await pool?.end();
  }
}
