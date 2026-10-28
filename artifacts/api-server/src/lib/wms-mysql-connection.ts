import { createConnection as createSocket } from "node:net";
import mysql, { type RowDataPacket } from "mysql2";
import type { WmsConnectionInput, WmsConnectionResult } from "@workspace/api-zod";
import { ConnectionFailure } from "./wms-connection-error";

/** Fail closed on roles, dynamic privileges, grant options and unrecognized grants. */
export function mysqlGrantsAreReadOnly(grants: string[]): boolean {
  return grants.length > 0 && grants.every((grant) => {
    if (/\bWITH GRANT OPTION\b/i.test(grant)) return false;
    const match = /^GRANT ([A-Z_, ]+) ON /i.exec(grant);
    return !!match && match[1].split(",").every((privilege) =>
      ["USAGE", "SELECT", "SHOW VIEW"].includes(privilege.trim().toUpperCase()));
  });
}

/** MySQL 8+ metadata probe only; never executes user SQL or reads WMS records. */
export async function testMysqlConnection(
  input: WmsConnectionInput, password: string, address: string,
): Promise<WmsConnectionResult> {
  const timeout = Math.min(input.queryTimeoutSec * 1000, 15000);
  const connection = mysql.createConnection({
    // Original DNS hostname supplies SNI and certificate identity. The TCP
    // socket uses only the previously approved and pinned network address.
    host: input.host, port: input.port, database: input.database,
    user: input.username, password,
    stream: () => createSocket({ host: address, port: input.port }),
    ssl: {
      rejectUnauthorized: true, verifyIdentity: true,
      ...(process.env.WMS_MYSQL_CA_CERT ? { ca: process.env.WMS_MYSQL_CA_CERT } : {}),
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
