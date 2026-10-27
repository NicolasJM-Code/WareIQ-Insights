import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
  clientsTable,
  membersTable,
  ownReportsTable,
  rolesTable,
  sitesTable,
} from "@workspace/db/schema";

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
  if (Array.isArray(value) && value.length === 0) return "'{}'";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error("Report fixture schema contains an unsupported column default");
}

type FixtureTable =
  | typeof clientsTable
  | typeof sitesTable
  | typeof rolesTable
  | typeof membersTable
  | typeof ownReportsTable;

function createTableFromDrizzleSchema(table: FixtureTable) {
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
    if (column.primary) parts.push("PRIMARY KEY");
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
    // Generate every table from the production schema so column, default,
    // foreign-key, check, and index changes cannot silently drift in tests.
    for (const table of [
      clientsTable,
      sitesTable,
      rolesTable,
      membersTable,
      ownReportsTable,
    ]) {
      await pool.query(createTableFromDrizzleSchema(table));
    }
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
