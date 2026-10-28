import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
  accessHistoryTable,
  clientsTable,
  membersTable,
  ownReportsTable,
  rolesTable,
  sitesTable,
} from "@workspace/db/schema";

// Never read DATABASE_URL or WMS settings. No TCP listener, customer database,
// shared development database, or caller-selected cleanup target is possible.
const directory = mkdtempSync(join(tmpdir(), "wareiq-report-pg-"));
export const socketDirectory = directory;
function getRegistryDirectory(): string {
  const value = process.env.WAREIQ_REPORT_TEST_REGISTRY;
  if (!value) throw new Error("Report test isolation registry must be configured");
  return value;
}
const registryDirectory = getRegistryDirectory();
let suiteId: string | undefined;
const fixtureId = randomUUID();
let registrationPath: string | undefined;
let peerSuiteId: string | undefined;
let peerRegistrationPath: string | undefined;
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
  host: socketDirectory, port: 5432, user: "report_test", database: "postgres",
  password: "", max: 2, connectionTimeoutMillis: 2_000,
});
export const db = drizzle(pool);
let started = false;
let stopped = false;

export function configureReportFixtureSuite(value: "own-reports-api" | "own-reports-origin" | "provider-evidence" | "capture-outage") {
  suiteId = value;
  // Only the two report-isolation suites participate in the peer handshake.
  // Evidence persistence must also run alone with its own registry identity.
  peerSuiteId = value === "own-reports-api" ? "own-reports-origin"
    : value === "own-reports-origin" ? "own-reports-api" : undefined;
  registrationPath = join(registryDirectory, `${suiteId}.json`);
  peerRegistrationPath = peerSuiteId ? join(registryDirectory, `${peerSuiteId}.json`) : undefined;
}

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
  | typeof accessHistoryTable
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

export async function startDatabase(options: { afterStart?: () => void | Promise<void> } = {}) {
  try {
    run("initdb", ["-D", data, "-U", "report_test", "--auth-local=trust", "--auth-host=reject", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o",
      `-F -k ${directory} -c listen_addresses=''`, "-w", "start"]);
    started = true;
    await options.afterStart?.();
    if (!suiteId || !registrationPath) {
      throw new Error("Report test fixture suite identity must be configured before schema setup");
    }
    // Generate every table from the production schema so column, default,
    // foreign-key, check, and index changes cannot silently drift in tests.
    for (const table of [
      accessHistoryTable,
      clientsTable,
      sitesTable,
      rolesTable,
      membersTable,
      ownReportsTable,
    ]) {
      await pool.query(createTableFromDrizzleSchema(table));
    }
    await pool.query(`
      CREATE TABLE wareiq_report_fixture_isolation (
        suite_id text PRIMARY KEY,
        fixture_id text NOT NULL,
        touched_by text
      )
    `);
    await pool.query(
      "INSERT INTO wareiq_report_fixture_isolation (suite_id, fixture_id) VALUES ($1, $2)",
      [suiteId, fixtureId],
    );
    const { rows } = await pool.query<{ system_identifier: string }>(
      "SELECT system_identifier::text FROM pg_control_system()",
    );
    writeFileSync(registrationPath, JSON.stringify({
      suiteId,
      fixtureId,
      socketDirectory,
      systemIdentifier: rows[0]?.system_identifier,
    }), { mode: 0o600 });
  } catch (error) {
    await stopDatabase();
    throw error; // Missing PostgreSQL binaries are a failure, never a skipped test.
  }
}

export async function waitForPeerFixture() {
  if (!peerRegistrationPath || !peerSuiteId) {
    throw new Error("Report test fixture suite identity must be configured before startup");
  }
  const deadline = Date.now() + 25_000;
  while (!existsSync(peerRegistrationPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Report test fixture did not register: ${peerSuiteId}`);
    }
    await delay(25);
  }
}

export async function assertFixtureIsolation() {
  await waitForPeerFixture();
  if (!peerRegistrationPath || !peerSuiteId || !suiteId) {
    throw new Error("Report test fixture suite identity must be configured before startup");
  }
  const peer = JSON.parse(readFileSync(peerRegistrationPath, "utf8")) as {
    suiteId: string;
    fixtureId: string;
    socketDirectory: string;
    systemIdentifier: string;
  };
  const ownSystem = await pool.query<{ system_identifier: string }>(
    "SELECT system_identifier::text FROM pg_control_system()",
  );
  const ownRows = await pool.query<{
    suite_id: string;
    fixture_id: string;
    touched_by: string | null;
  }>("SELECT suite_id, fixture_id, touched_by FROM wareiq_report_fixture_isolation");
  const client = await pool.connect();
  let peerMutationCount: number | null = null;
  try {
    await client.query("BEGIN");
    const mutation = await client.query(
      `UPDATE wareiq_report_fixture_isolation
       SET touched_by = $1
       WHERE suite_id <> $1
       RETURNING suite_id`,
      [suiteId],
    );
    peerMutationCount = mutation.rowCount;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  if (peer.suiteId !== peerSuiteId || peer.fixtureId === fixtureId) {
    throw new Error("Report test fixture registry contains an invalid peer identity");
  }
  if (peer.socketDirectory === socketDirectory) {
    throw new Error("Report persistence suites share a PostgreSQL socket directory");
  }
  if (peer.systemIdentifier === ownSystem.rows[0]?.system_identifier) {
    throw new Error("Report persistence suites share a PostgreSQL cluster");
  }
  if (peerMutationCount !== 0) {
    throw new Error("A report persistence suite can alter another suite's fixture row");
  }
  if (ownRows.rows.length !== 1 || ownRows.rows[0].suite_id !== suiteId
      || ownRows.rows[0].fixture_id !== fixtureId || ownRows.rows[0].touched_by !== null) {
    throw new Error("A report persistence suite can observe another suite's fixture row");
  }
}

// Simulate a real storage outage, not a rejected mock or a missing table.
// Drain only idle fixture connections first: this check tests unavailable
// storage, not asynchronous connection loss on an in-flight operation.
export async function pauseDatabase() {
  if (!started || stopped || pool.waitingCount || pool.totalCount !== pool.idleCount) {
    throw new Error("Only a running, idle private report database can be paused");
  }
  while (pool.totalCount) {
    const client = await pool.connect();
    client.release(true);
  }
  run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  started = false;
}

export async function resumeDatabase() {
  if (started || stopped) throw new Error("Private report database is not paused");
  run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o",
    `-F -k ${directory} -c listen_addresses=''`, "-w", "start"]);
  started = true;
}

export async function stopDatabase() {
  if (stopped) return;
  stopped = true;
  try {
    await pool.end();
  } finally {
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
}
