import { createConnection as createSocket } from "node:net";
import type { Duplex } from "node:stream";
import mysql, { type RowDataPacket } from "mysql2";
import type { WmsConnectionInput, WmsConnectionResult } from "@workspace/api-zod";
import { ConnectionFailure } from "./wms-connection-error";

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const maxReportRows = 500;
const maxReportBytes = 1_000_000;

/** Supplied only by server configuration, never from WmsConnectionInput. */
export interface MysqlTrustRoots { ca?: string }
function directTrustRoots(): MysqlTrustRoots {
  return process.env.WMS_MYSQL_CA_CERT ? { ca: process.env.WMS_MYSQL_CA_CERT } : {};
}

export interface MysqlReportMapping {
  view: string;
  clientColumn: string;
  siteColumn: string;
  columns: Record<string, string>;
}

export interface MysqlReportScope {
  clientKey: string;
  siteKey: string;
}

/** Read only server-owned mappings; mapping data is never accepted from a request. */
export function getMysqlReportMapping(key: string, raw = process.env.WMS_MYSQL_REPORT_MAPPINGS): MysqlReportMapping | undefined {
  if (!raw) return undefined;
  if (raw.length > 100_000) throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mappings exceed the allowed size.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mappings are not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mappings must be an object.");
  if (!Object.hasOwn(parsed, key)) return undefined;
  const candidate = (parsed as Record<string, unknown>)[key];
  if (candidate === undefined) return undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mapping is invalid.");
  const value = candidate as Record<string, unknown>;
  const columns = value.columns;
  if (Object.keys(value).some((name) => !["view", "clientColumn", "siteColumn", "columns"].includes(name)) ||
      typeof value.view !== "string" || !identifierPattern.test(value.view) ||
      typeof value.clientColumn !== "string" || !identifierPattern.test(value.clientColumn) ||
      typeof value.siteColumn !== "string" || !identifierPattern.test(value.siteColumn) ||
      !columns || typeof columns !== "object" || Array.isArray(columns)) {
    throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mapping is invalid.");
  }
  const entries = Object.entries(columns as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 50 ||
      entries.some(([alias, column]) => !identifierPattern.test(alias) || typeof column !== "string" || !identifierPattern.test(column)))
    throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mapping has invalid or excessive columns.");
  return {
    view: value.view,
    clientColumn: value.clientColumn,
    siteColumn: value.siteColumn,
    columns: Object.fromEntries(entries as [string, string][]),
  };
}

/** Fail closed on roles, dynamic privileges, grant options and unrecognized grants. */
export function mysqlGrantsAreReadOnly(grants: string[]): boolean {
  return grants.length > 0 && grants.every((grant) => {
    if (/\bWITH GRANT OPTION\b/i.test(grant)) return false;
    const match = /^GRANT ([A-Z_, ]+) ON /i.exec(grant);
    return !!match && match[1].split(",").every((privilege) =>
      ["USAGE", "SELECT", "SHOW VIEW"].includes(privilege.trim().toUpperCase()));
  });
}

function quoteIdentifier(identifier: string): string {
  if (!identifierPattern.test(identifier)) throw new ConnectionFailure("REPORT_MAPPING_INVALID", "The approved MySQL report mapping contains an invalid identifier.");
  return `\`${identifier}\``;
}

function reportCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 8192);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("utf8").slice(0, 8192);
  try { return JSON.stringify(value).slice(0, 8192); }
  catch { return String(value).slice(0, 8192); }
}

/** Execute one mapped report with mandatory client/site filters and a hard row cap. */
export async function runMysqlReport(
  input: WmsConnectionInput,
  password: string,
  address: string,
  mapping: MysqlReportMapping,
  scope: MysqlReportScope,
  selectedFields?: string[],
  stream?: Duplex,
  trust: MysqlTrustRoots = directTrustRoots(),
): Promise<{ columns: string[]; rows: Array<Record<string, string | number | boolean | null>>; truncated: boolean }> {
  const fields = selectedFields ?? Object.keys(mapping.columns);
  if (!fields.length || fields.length > 50 || fields.some((field) => !Object.hasOwn(mapping.columns, field)))
    throw new ConnectionFailure("REPORT_MAPPING_INVALID", "This report requests fields that are not in its approved MySQL mapping.");
  const projected = fields.map((field) => `${quoteIdentifier(mapping.columns[field])} AS ${quoteIdentifier(field)}`).join(", ");
  const from = `${quoteIdentifier(input.database)}.${quoteIdentifier(mapping.view)}`;
  const clientColumn = quoteIdentifier(mapping.clientColumn);
  const siteColumn = quoteIdentifier(mapping.siteColumn);
  const sql = `SELECT /*+ MAX_EXECUTION_TIME(15000) */ ${projected} FROM ${from} WHERE ${clientColumn} = ? AND ${siteColumn} = ? LIMIT ${maxReportRows + 1}`;
  const timeout = Math.min(input.queryTimeoutSec * 1000, 15000);
  const connection = mysql.createConnection({
    host: input.host, port: input.port, database: input.database,
    user: input.username, password,
    stream: () => stream ?? createSocket({ host: address, port: input.port }),
    ssl: {
      rejectUnauthorized: true, verifyIdentity: true,
      ...(trust.ca ? { ca: trust.ca } : {}),
    },
    connectTimeout: 8000, multipleStatements: false,
    enableKeepAlive: false, maxPreparedStatements: 0,
  });
  connection.on("error", () => {});
  const db = connection.promise();
  const query = async (sql: string, values: (string | number)[] = []) =>
    (await db.query<RowDataPacket[]>({ sql, values, timeout }))[0];
  try {
    await query("START TRANSACTION READ ONLY");
    const roles = await query("SELECT CURRENT_ROLE() AS active_roles");
    const grants = await query("SHOW GRANTS");
    if (roles[0]?.active_roles !== "NONE" ||
        !mysqlGrantsAreReadOnly(grants.map((row) => String(Object.values(row)[0]))))
      throw new ConnectionFailure("READ_ONLY_ROLE_REQUIRED",
        "MySQL reports require a dedicated SELECT/SHOW VIEW-only account without active roles or elevated privileges.");
    const result = await query(sql, [scope.clientKey, scope.siteKey]);
    const rows: Array<Record<string, string | number | boolean | null>> = [];
    let bytes = 0;
    let truncated = result.length > maxReportRows;
    for (const sourceRow of result.slice(0, maxReportRows)) {
      const row = Object.fromEntries(fields.map((field) => [field, reportCell(sourceRow[field])]));
      const rowBytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes + rowBytes > maxReportBytes) { truncated = true; break; }
      rows.push(row);
      bytes += rowBytes;
    }
    await query("ROLLBACK");
    return { columns: fields, rows, truncated };
  } finally {
    connection.destroy();
  }
}

/** MySQL 8+ metadata probe only; never executes user SQL or reads WMS records. */
export async function testMysqlConnection(
  input: WmsConnectionInput, password: string, address: string,
  stream?: Duplex,
  trust: MysqlTrustRoots = directTrustRoots(),
): Promise<WmsConnectionResult> {
  const timeout = Math.min(input.queryTimeoutSec * 1000, 15000);
  const connection = mysql.createConnection({
    // Original DNS hostname supplies SNI and certificate identity. The TCP
    // socket uses only the previously approved and pinned network address.
    host: input.host, port: input.port, database: input.database,
    user: input.username, password,
    stream: () => stream ?? createSocket({ host: address, port: input.port }),
    ssl: {
      rejectUnauthorized: true, verifyIdentity: true,
      ...(trust.ca ? { ca: trust.ca } : {}),
    },
    connectTimeout: 8000, multipleStatements: false,
    enableKeepAlive: false, maxPreparedStatements: 0,
  });
  // mysql2 may emit an event as well as rejecting the command promise.
  connection.on("error", () => {});
  const db = connection.promise();
  const query = async (sql: string, values: string[] = []) =>
    (await db.query<RowDataPacket[]>({ sql, values, timeout }))[0];
  try {
    await query("START TRANSACTION READ ONLY");
    const roles = await query("SELECT CURRENT_ROLE() AS active_roles");
    const grants = await query("SHOW GRANTS");
    if (roles[0]?.active_roles !== "NONE"
      || !mysqlGrantsAreReadOnly(grants.map((row) => String(Object.values(row)[0])))) {
      throw new ConnectionFailure("READ_ONLY_ROLE_REQUIRED",
        "MySQL requires a dedicated SELECT/SHOW VIEW-only account without roles, elevated privileges or grant options.");
    }
    const schemas = await query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [input.database]);
    if (!schemas.length) {
      throw new ConnectionFailure("SCHEMA_ACCESS_DENIED", "The reporting database is not accessible to this account.");
    }
    const views = await query(
      "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? LIMIT 1", [input.database]);
    if (!views.length) {
      throw new ConnectionFailure("REPORTING_VIEWS_REQUIRED",
        "MySQL is reachable, but no accessible reporting views were found. SELECT and SHOW VIEW on approved views are required.");
    }
    await query("ROLLBACK");
    const at = new Date().toISOString();
    return {
      status: "connected", code: "CONNECTED", testedAt: at, lastSuccessfulAt: at,
      message: "MySQL verified TLS, authentication, read-only grants and database access succeeded. Only metadata was read. Reports remain sample data until source views are approved and mapped.",
    };
  } finally {
    // Destroy on success and failure: no live connection or open transaction
    // survives a failed probe. No cleanup query can mask a driver failure.
    connection.destroy();
  }
}
