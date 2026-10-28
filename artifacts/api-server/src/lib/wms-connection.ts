import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity as pgServerIdentity } from "node:tls";
import pg from "pg";
import ipaddr from "ipaddr.js";
import type { WmsConnectionInput, WmsConnectionResult } from "@workspace/api-zod";
import { ConnectionFailure } from "./wms-connection-error";
import { runMysqlReport, testMysqlConnection, type MysqlReportMapping, type MysqlReportScope } from "./wms-mysql-connection";
export { ConnectionFailure } from "./wms-connection-error";

/** Never include the driver message, query, config, or cause in a response/log. */
export function safeConnectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof ConnectionFailure) return error;
  const code = (error as { code?: string })?.code;
  if (code === "28P01" || code === "28000" || code === "ER_ACCESS_DENIED_ERROR")
    return new ConnectionFailure("AUTHENTICATION_FAILED", "The database rejected the reporting username or server-side password.");
  if (code === "3D000" || code === "ER_BAD_DB_ERROR")
    return new ConnectionFailure("DATABASE_NOT_FOUND", "The database name was not found. Check the Database name field.");
  if (code === "42501" || code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_TABLEACCESS_DENIED_ERROR")
    return new ConnectionFailure("ACCESS_DENIED", "The reporting account cannot access the selected database or schema.");
  if (code === "3F000")
    return new ConnectionFailure("SCHEMA_NOT_FOUND", "The selected reporting schema does not exist. Check the Database schema field.");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return new ConnectionFailure("HOST_NOT_FOUND", "The database hostname could not be resolved.");
  if (code === "ECONNREFUSED")
    return new ConnectionFailure("CONNECTION_REFUSED", "The database refused the connection. Check the database port and firewall.");
  if (code?.includes("CERT") || code?.includes("TLS") || code?.includes("SSL") ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      /ssl|tls|certificate/i.test(String((error as Error)?.message)))
    return new ConnectionFailure("TLS_FAILED", "Verified TLS could not be established. Check the database certificate and hostname; a private CA must be configured server-side.");
  if (code === "57014" || code === "ETIMEDOUT" || code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
      /timeout|timed out/i.test(String((error as Error)?.message)))
    return new ConnectionFailure("TIMEOUT", "The connection or query timed out. Check network access and the database port.");
  return new ConnectionFailure("CONNECTION_FAILED", "The database connection failed. Check the server address, port, database and network access.");
}

/** Credentials may only reach a destination approved in server configuration.
 * Administrator form fields are untrusted destinations, not an allowlist. */
function reportingPassword(input: WmsConnectionInput): string {
  const mysql = input.engine === "mysql";
  const prefix = mysql ? "WMS_MYSQL" : "WMS";
  const standalonePassword = process.env[mysql ? "WMS_MYSQL_PASSWORD" : "WMS_PGPASSWORD"];
  type Destination = { host: string; port: number; database: string; username: string };
  let urlDestination: (Destination & { password: string }) | undefined;
  try {
    const url = new URL(process.env[`${prefix}_DATABASE_URL`] ?? "");
    if (!(mysql ? ["mysql:"] : ["postgres:", "postgresql:"]).includes(url.protocol)) throw new Error();
    const username = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!username || !database) throw new Error();
    urlDestination = { host: url.hostname, port: Number(url.port || (mysql ? 3306 : 5432)),
      database, username, password: decodeURIComponent(url.password) };
  } catch { /* An invalid URL is never an approved destination. */ }
  const password = standalonePassword || urlDestination?.password;
  if (!password) throw new ConnectionFailure("PASSWORD_NOT_CONFIGURED",
    "Configure WMS credentials securely on the server. Passwords are never stored in this browser.");
  const configured = ["HOST", "PORT", "DATABASE", "USERNAME"].map((key) => process.env[`${prefix}_APPROVED_${key}`]);
  let approved: Destination | undefined;
  if (configured.some((value) => value !== undefined)) {
    const [host, rawPort, database, username] = configured;
    const port = Number(rawPort);
    if (!host || !database || !username || !rawPort || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new ConnectionFailure("DESTINATION_NOT_CONFIGURED",
        "The approved WMS destination is incomplete. An owner must configure its host, port, database and username on the server.");
    approved = { host, port, database, username };
  } else {
    // An engine-specific server-held URL can itself bind either password source.
    approved = urlDestination;
  }
  if (!approved) throw new ConnectionFailure("DESTINATION_NOT_CONFIGURED",
    "An owner must approve the WMS host, port, database and username on the server before testing a connection.");
  const matches = (destination: Destination) =>
    destination.host.toLowerCase() === input.host.toLowerCase() &&
    destination.port === input.port && destination.database === input.database &&
    destination.username === input.username;
  if (!matches(approved) || (!standalonePassword && (!urlDestination || !matches(urlDestination))))
    throw new ConnectionFailure("SECRET_MISMATCH",
      "These fields do not match the server-approved WMS destination. Credentials were not sent. Ask an owner to approve any destination change securely.");
  return password;
}

/** Build report credentials only from the server's MySQL secret/approval settings. */
function configuredMysqlReportInput(): WmsConnectionInput | undefined {
  const keys = ["WMS_MYSQL_DATABASE_URL", "WMS_MYSQL_PASSWORD", "WMS_MYSQL_APPROVED_HOST",
    "WMS_MYSQL_APPROVED_PORT", "WMS_MYSQL_APPROVED_DATABASE", "WMS_MYSQL_APPROVED_USERNAME"];
  if (keys.every((key) => process.env[key] === undefined)) return undefined;
  let destination: { host: string; port: number; database: string; username: string } | undefined;
  try {
    const url = new URL(process.env.WMS_MYSQL_DATABASE_URL ?? "");
    if (url.protocol !== "mysql:") throw new Error();
    destination = {
      host: url.hostname, port: Number(url.port || 3306),
      database: decodeURIComponent(url.pathname.slice(1)),
      username: decodeURIComponent(url.username),
    };
  } catch { /* Standalone passwords require all four explicit approval values below. */ }
  const approved = {
    host: process.env.WMS_MYSQL_APPROVED_HOST,
    port: process.env.WMS_MYSQL_APPROVED_PORT,
    database: process.env.WMS_MYSQL_APPROVED_DATABASE,
    username: process.env.WMS_MYSQL_APPROVED_USERNAME,
  };
  const hasExplicitApproval = Object.values(approved).some((value) => value !== undefined);
  if (hasExplicitApproval) {
    const port = Number(approved.port);
    if (!approved.host || !approved.database || !approved.username || !approved.port ||
        !Number.isInteger(port) || port < 1 || port > 65535)
      throw new ConnectionFailure("DESTINATION_NOT_CONFIGURED", "The approved MySQL destination is incomplete.");
    destination = { host: approved.host, port, database: approved.database, username: approved.username };
  }
  if (!destination)
    throw new ConnectionFailure("DESTINATION_NOT_CONFIGURED", "Configure a valid server-approved MySQL URL or a password and complete destination approval.");
  return {
    engine: "mysql", ...destination, schema: destination.database,
    sslMode: "verify-full", queryTimeoutSec: 15,
  };
}

export type WmsAddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const privateNetworkBlocks = [
  ipaddr.parseCIDR("10.0.0.0/8"),
  ipaddr.parseCIDR("172.16.0.0/12"),
  ipaddr.parseCIDR("192.168.0.0/16"),
  ipaddr.parseCIDR("fc00::/7"),
];

function privateNetworkPolicy(env: NodeJS.ProcessEnv) {
  const enabledValue = env.WMS_PRIVATE_NETWORK_ENABLED;
  if (enabledValue !== undefined && enabledValue !== "true" && enabledValue !== "false")
    throw new ConnectionFailure("NETWORK_POLICY_INVALID",
      "The private network setting must be explicitly true or false. An owner must configure it on the server.");
  if (enabledValue !== "true") return { enabled: false, networks: [] as ReturnType<typeof ipaddr.parseCIDR>[] };

  const entries = env.WMS_PRIVATE_NETWORK_CIDRS?.split(",").map((entry) => entry.trim());
  if (!entries?.length || entries.length > 64 || entries.some((entry) => !entry))
    throw new ConnectionFailure("PRIVATE_NETWORK_NOT_CONFIGURED",
      "Private WMS networking requires approved private CIDR ranges configured by an owner on the server.");
  try {
    const networks = entries.map((entry) => ipaddr.parseCIDR(entry));
    const onlyPrivateRanges = networks.every(([network, prefix]) =>
      privateNetworkBlocks.some(([privateNetwork, privatePrefix]) =>
        network.kind() === privateNetwork.kind() &&
        prefix >= privatePrefix &&
        network.match(privateNetwork, privatePrefix),
      ),
    );
    if (!onlyPrivateRanges) throw new Error("CIDR outside private address space");
    return { enabled: true, networks };
  } catch {
    throw new ConnectionFailure("NETWORK_POLICY_INVALID",
      "The approved private network policy is invalid. Configure only RFC1918 IPv4 or IPv6 unique-local CIDR ranges on the server.");
  }
}

async function approvedAddress(
  host: string,
  env: NodeJS.ProcessEnv,
  resolver: WmsAddressResolver,
): Promise<string> {
  const policy = privateNetworkPolicy(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConnectionFailure("TIMEOUT", "Hostname lookup timed out.")), 5000);
      }),
    ]);
    if (!addresses.length)
      throw new ConnectionFailure("HOST_NOT_ALLOWED", "The database hostname has no approved network addresses.");
    let parsedAddresses: Array<{ address: string; range: string; parsed: ReturnType<typeof ipaddr.process> }>;
    try {
      parsedAddresses = addresses.map(({ address }) => {
        const parsed = ipaddr.process(address);
        return { address: parsed.toString(), range: parsed.range(), parsed };
      });
    } catch {
      throw new ConnectionFailure("HOST_NOT_ALLOWED", "The database hostname returned an invalid network address.");
    }

    // Accept an all-public answer set by default, or an all-private set inside
    // the explicit owner-approved CIDRs. Reject mixed sets and pin the selected
    // numeric address so the PostgreSQL driver cannot perform another DNS lookup.
    if (parsedAddresses.every(({ range }) => range === "unicast"))
      return parsedAddresses[0].address;
    const allPrivateAndApproved = policy.enabled && parsedAddresses.every(({ parsed, range }) =>
      (range === "private" || range === "uniqueLocal") &&
      policy.networks.some(([network, prefix]) =>
        parsed.kind() === network.kind() && parsed.match(network, prefix),
      ),
    );
    if (allPrivateAndApproved) return parsedAddresses[0].address;
    throw new ConnectionFailure("HOST_NOT_ALLOWED",
      "This WMS address is outside the server-approved network policy. Private VPN addresses require explicit server configuration, and every DNS answer must match it.");
  } finally {
    clearTimeout(timer);
  }
}

/** Server-only report execution; browser-supplied connection values are never used. */
export async function executeApprovedMysqlReport(
  mapping: MysqlReportMapping,
  scope: MysqlReportScope,
  fields?: string[],
  dependencies: { resolveHost?: WmsAddressResolver } = {},
) {
  const input = configuredMysqlReportInput();
  if (!input) return undefined;
  if (isIP(input.host))
    throw new ConnectionFailure("TLS_HOSTNAME_REQUIRED", "Use an approved MySQL DNS hostname matching its TLS certificate.");
  const password = reportingPassword(input);
  const address = await approvedAddress(input.host, process.env,
    dependencies.resolveHost ?? ((host) => lookup(host, { all: true })));
  return runMysqlReport(input, password, address, mapping, scope, fields);
}

export async function testConnection(
  input: WmsConnectionInput,
  dependencies: { resolveHost?: WmsAddressResolver } = {},
): Promise<WmsConnectionResult> {
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  try {
    if (input.engine === "mysql") {
      if (input.schema !== input.database)
        throw new ConnectionFailure("SCHEMA_MISMATCH", "MySQL uses the database name as its schema. Set both fields to the same name.");
      if (isIP(input.host))
        throw new ConnectionFailure("TLS_HOSTNAME_REQUIRED", "Use the MySQL DNS hostname matching its TLS certificate, not a numeric IP address.");
    }
    const password = reportingPassword(input);
    const address = await approvedAddress(input.host, process.env,
      dependencies.resolveHost ?? ((host) => lookup(host, { all: true })));
    if (input.engine === "mysql") return await testMysqlConnection(input, password, address);
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
