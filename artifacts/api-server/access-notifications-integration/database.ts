import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import { accessNotificationsTable } from "@workspace/db/schema";

// This fixture only connects to its own Unix-socket-only PostgreSQL cluster.
// It never reads DATABASE_URL, WMS_DATABASE_URL, or any caller-selected host.
const directory = mkdtempSync(join(tmpdir(), "wareiq-access-notifications-pg-"));
const dataDirectory = join(directory, "data");
const postgresEnv = {
  PATH: process.env.PATH,
  HOME: directory,
  LANG: "C",
  LC_ALL: "C",
};
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { env: postgresEnv, stdio: "pipe", timeout: 20_000 });

export const socketDirectory = directory;
export const pool = new Pool({
  host: socketDirectory,
  port: 5432,
  user: "access_notification_test",
  database: "postgres",
  password: "",
  max: 8,
  connectionTimeoutMillis: 2_000,
});
export const db = drizzle(pool, { schema });
let started = false;
let stopped = false;

function renderDefault(value: unknown): string {
  if (value instanceof SQL) return new PgDialect().sqlToQuery(value).sql;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error("Unsupported default in access notification test schema");
}

function tableSql() {
  const config = getTableConfig(accessNotificationsTable);
  const definitions = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.notNull) parts.push("NOT NULL");
    if (column.primary) parts.push("PRIMARY KEY");
    if (column.hasDefault) parts.push("DEFAULT", renderDefault(column.default));
    return parts.join(" ");
  });
  const statements = [`CREATE TABLE "${config.name}" (${definitions.join(", ")})`];
  for (const index of config.indexes) {
    const { name, columns, where } = index.config;
    if (!name) throw new Error("Access notification test schema index is unnamed");
    const indexedColumns = columns.map((column) => {
      const indexedColumn = column as { name?: string };
      if (!indexedColumn.name) throw new Error("Unsupported access notification test index");
      return `"${indexedColumn.name}"`;
    });
    statements.push(
      `CREATE INDEX "${name}" ON "${config.name}" (${indexedColumns.join(", ")})${
        where ? ` WHERE ${new PgDialect().sqlToQuery(where).sql}` : ""
      }`,
    );
  }
  return statements.join(";\n");
}

export async function startDatabase() {
  try {
    run("initdb", [
      "-D", dataDirectory, "-U", "access_notification_test",
      "--auth-local=trust", "--auth-host=reject", "--no-locale",
    ]);
    run("pg_ctl", [
      "-D", dataDirectory, "-l", join(directory, "postgres.log"), "-o",
      `-F -k ${directory} -c listen_addresses=''`, "-w", "start",
    ]);
    started = true;
    await pool.query(tableSql());
  } catch (error) {
    await stopDatabase();
    throw error;
  }
}

export async function stopDatabase() {
  if (stopped) return;
  stopped = true;
  try {
    await pool.end();
  } finally {
    try {
      run("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "-w", "stop"]);
    } catch (error) {
      if (started) throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
      started = false;
    }
  }
}
