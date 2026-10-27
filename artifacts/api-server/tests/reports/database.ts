import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { ownReportsTable } from "@workspace/db/schema";

// Never read DATABASE_URL or WMS settings. No TCP listener, customer database,
// shared development database, or caller-selected cleanup target is possible.
const directory = mkdtempSync(join(tmpdir(), "wareiq-report-pg-"));
const data = join(directory, "data");
const postgresEnv = {
  PATH: process.env.PATH,
  HOME: directory,
  LANG: "C",
  LC_ALL: "C",
};
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { env: postgresEnv, stdio: "pipe", timeout: 20_000 });
export const pool = new Pool({
  host: directory, port: 5432, user: "report_test", database: "postgres",
  password: "", max: 2, connectionTimeoutMillis: 2_000,
});
export const db = drizzle(pool);
let started = false;
let stopped = false;

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const dialect = new PgDialect();

function renderSchemaSql(expression: SQL) {
  const query = dialect.sqlToQuery(expression, "indexes");
  if (query.params.length) {
    throw new Error("Report fixture schema contains a parameterized SQL expression");
  }
  return query.sql;
}

function renderDefault(value: unknown): string {
  if (value instanceof SQL) return renderSchemaSql(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error("Report fixture schema contains an unsupported column default");
}

function createTableFromDrizzleSchema(table: typeof ownReportsTable) {
  const config = getTableConfig(table);
  const tableName = config.schema
    ? `${quoteIdentifier(config.schema)}.${quoteIdentifier(config.name)}`
    : quoteIdentifier(config.name);
  const definitions = config.columns.map((column) => {
    if (column.generated) {
      throw new Error(`Report fixture cannot generate column ${column.name}`);
    }
    const parts = [quoteIdentifier(column.name), column.getSQLType()];
    if (column.notNull) parts.push("NOT NULL");
    if (column.hasDefault) {
      if (column.defaultFn) {
        throw new Error(`Report fixture cannot generate runtime default for ${column.name}`);
      }
      parts.push("DEFAULT", renderDefault(column.default));
    }
    return parts.join(" ");
  });

  for (const primaryKey of config.primaryKeys) {
    definitions.push(
      `CONSTRAINT ${quoteIdentifier(primaryKey.getName())} PRIMARY KEY (${primaryKey.columns
        .map((column) => quoteIdentifier(column.name)).join(", ")})`,
    );
  }
  for (const uniqueConstraint of config.uniqueConstraints) {
    if (!uniqueConstraint.name) {
      throw new Error(`Report fixture schema has an unnamed unique constraint on ${config.name}`);
    }
    definitions.push(
      `CONSTRAINT ${quoteIdentifier(uniqueConstraint.name)} UNIQUE (${uniqueConstraint.columns
        .map((column) => quoteIdentifier(column.name)).join(", ")})`,
    );
  }
  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    const foreignTable = getTableConfig(reference.foreignTable);
    const foreignTableName = foreignTable.schema
      ? `${quoteIdentifier(foreignTable.schema)}.${quoteIdentifier(foreignTable.name)}`
      : quoteIdentifier(foreignTable.name);
    const actions = [
      foreignKey.onDelete && `ON DELETE ${foreignKey.onDelete.toUpperCase()}`,
      foreignKey.onUpdate && `ON UPDATE ${foreignKey.onUpdate.toUpperCase()}`,
    ].filter(Boolean);
    definitions.push(
      `CONSTRAINT ${quoteIdentifier(foreignKey.getName())} FOREIGN KEY (${reference.columns
        .map((column) => quoteIdentifier(column.name)).join(", ")}) REFERENCES ${foreignTableName} (${reference.foreignColumns
        .map((column) => quoteIdentifier(column.name)).join(", ")})${actions.length ? ` ${actions.join(" ")}` : ""}`,
    );
  }
  for (const check of config.checks) {
    definitions.push(`CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${renderSchemaSql(check.value)})`);
  }

  const statements = [`CREATE TABLE ${tableName} (${definitions.join(", ")})`];
  for (const index of config.indexes) {
    const { name, unique, concurrently, only, method, columns, where, with: storageParameters } = index.config;
    if (!name) throw new Error(`Report fixture schema has an unnamed index on ${config.name}`);
    const indexedColumns = columns.map((column) => {
      let expression: string;
      if (column instanceof SQL) {
        expression = renderSchemaSql(column);
      } else {
        const indexedColumn = column as {
          name?: string;
          indexConfig?: { order?: string; nulls?: string; opClass?: string };
        };
        if (!indexedColumn.name || !indexedColumn.indexConfig) {
          throw new Error(`Report fixture schema has an unsupported index column on ${config.name}`);
        }
        expression = quoteIdentifier(indexedColumn.name);
        const { order, nulls, opClass } = indexedColumn.indexConfig;
        return `${expression}${opClass ? ` ${opClass}` : ""}${order ? ` ${order.toUpperCase()}` : ""}${nulls ? ` NULLS ${nulls.toUpperCase()}` : ""}`;
      }
      return expression;
    });
    const indexTableName = only ? `ONLY ${tableName}` : tableName;
    const using = method ? ` USING ${method}` : "";
    const params = storageParameters
      ? ` WITH (${Object.entries(storageParameters).map(([key, value]) => `${key} = ${renderDefault(value)}`).join(", ")})`
      : "";
    const predicate = where ? ` WHERE ${renderSchemaSql(where)}` : "";
    statements.push(
      `CREATE ${unique ? "UNIQUE " : ""}INDEX ${concurrently ? "CONCURRENTLY " : ""}${quoteIdentifier(name)} ON ${indexTableName}${using} (${indexedColumns.join(", ")})${params}${predicate}`,
    );
  }
  return statements.join(";\n");
}

export async function startDatabase() {
  try {
    run("initdb", ["-D", data, "-U", "report_test", "--auth-local=trust", "--auth-host=reject", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o",
      `-F -k ${directory} -c listen_addresses=''`, "-w", "start"]);
    started = true;
    // These supporting tables stay minimal; the report table and its indexes
    // are generated from the real Drizzle schema to prevent constraint drift.
    await pool.query(`
      CREATE TABLE wareiq_clients (id text PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true);
      CREATE TABLE wareiq_sites (
        id text PRIMARY KEY, client_id text NOT NULL REFERENCES wareiq_clients(id),
        source_id text NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT true);
      CREATE TABLE wareiq_roles (
        id text PRIMARY KEY, client_id text NOT NULL REFERENCES wareiq_clients(id), name text NOT NULL,
        report_ids text[] NOT NULL DEFAULT '{}', can_create_own_reports boolean NOT NULL DEFAULT false);
      CREATE TABLE wareiq_members (
        id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
        client_id text NOT NULL REFERENCES wareiq_clients(id), role_id text NOT NULL REFERENCES wareiq_roles(id),
        site_ids text[] NOT NULL DEFAULT '{}', primary_site_id text, active boolean NOT NULL DEFAULT true);
    `);
    await pool.query(createTableFromDrizzleSchema(ownReportsTable));
  } catch (error) {
    await stopDatabase();
    throw error; // Missing PostgreSQL binaries are a failure, never a skipped test.
  }
}

export async function stopDatabase() {
  if (stopped) return;
  stopped = true;
  await pool.end();
  // Check the private data directory even after a partially failed start.
  try {
    run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  } catch (error) {
    if (started) throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
    started = false;
  }
}
