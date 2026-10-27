import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

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

export async function startDatabase() {
  try {
    run("initdb", ["-D", data, "-U", "report_test", "--auth-local=trust", "--auth-host=reject", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o",
      `-F -k ${directory} -c listen_addresses=''`, "-w", "start"]);
    started = true;
    // Minimal access schema fixture; report columns, FK and expression index
    // mirror lib/db/src/schema/access.ts. All queries use the real Drizzle schema.
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
      CREATE TABLE wareiq_own_reports (
        id text PRIMARY KEY, owner_id text NOT NULL,
        client_id text NOT NULL REFERENCES wareiq_clients(id), definition jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX wareiq_own_report_name_unique ON wareiq_own_reports
        (owner_id, client_id, (definition->>'section'), lower(definition->>'name'));
    `);
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
