import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { accessHistoryTable } from "@workspace/db/schema";

// No caller-provided URL, path, PG* variable or application/WMS credential is
// accepted. Every connection, including children, uses this private Unix socket.
export class PrivateDatabase {
  readonly directory = mkdtempSync(join(tmpdir(), "wareiq-audit-pg-"));
  private readonly data = join(this.directory, "data");
  readonly connectionString = `postgresql://audit_test@/postgres?host=${encodeURIComponent(this.directory)}`;
  private currentPool = this.createPool();
  get pool() { return this.currentPool; }
  private started = false;
  private stopped = false;

  private createPool() {
    return new Pool({
      connectionString: this.connectionString,
      password: "",
      max: 4,
      connectionTimeoutMillis: 2_000,
    });
  }

  private run(command: string, args: string[]) {
    execFileSync(command, args, {
      env: { PATH: process.env.PATH, HOME: this.directory, LANG: "C", LC_ALL: "C" },
      stdio: "pipe",
      timeout: 20_000,
    });
  }

  private startPostgres() {
    this.run("pg_ctl", ["-D", this.data, "-l", join(this.directory, "postgres.log"),
      "-o", `-k ${this.directory} -c listen_addresses=''`, "-w", "start"]);
    this.started = true;
  }

  async start() {
    try {
      this.run("initdb", ["-D", this.data, "-U", "audit_test",
        "--auth-local=trust", "--auth-host=reject", "--no-locale"]);
      this.startPostgres();
      // Render the actual history schema, not a second handwritten table.
      const config = getTableConfig(accessHistoryTable);
      const dialect = new PgDialect();
      const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
      const columns = config.columns.map((column) => {
        let definition = `${quote(column.name)} ${column.getSQLType()}`;
        if (column.notNull) definition += " NOT NULL";
        if (column.primary) definition += " PRIMARY KEY";
        if (column.hasDefault) {
          if (column.default instanceof SQL) {
            const query = dialect.sqlToQuery(column.default);
            if (query.params.length) throw new Error("Unsupported parameterized schema default");
            definition += ` DEFAULT ${query.sql}`;
          } else if (typeof column.default === "string") {
            definition += ` DEFAULT '${column.default.replaceAll("'", "''")}'`;
          } else throw new Error("Unsupported history schema default");
        }
        return definition;
      });
      await this.pool.query(`CREATE TABLE ${quote(config.name)} (${columns.join(", ")})`);
    } catch (error) {
      await this.stop();
      throw error; // Missing binaries or startup failure must fail, never skip.
    }
  }

  async crashAndRestart() {
    if (!this.started || this.stopped) throw new Error("Private PostgreSQL is not running");
    // Retire only the test observer's idle connections. Application workers
    // remain connected and experience the real server interruption.
    await this.currentPool.end();
    // Keep teardown usable even if stopping or restarting PostgreSQL fails.
    this.currentPool = this.createPool();
    const log = join(this.directory, "postgres.log");
    const previousLogLength = readFileSync(log, "utf8").length;
    // Immediate shutdown aborts active transactions without a clean checkpoint;
    // restart the same data directory, never initdb or recreate the schema.
    this.run("pg_ctl", ["-D", this.data, "-m", "immediate", "-w", "stop"]);
    this.started = false;
    this.startPostgres();
    return readFileSync(log, "utf8").slice(previousLogLength);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.pool.end();
    } finally {
      try {
        this.run("pg_ctl", ["-D", this.data, "-m", "immediate", "-w", "stop"]);
      } catch (error) {
        if (this.started) throw error;
      } finally {
        rmSync(this.directory, { recursive: true, force: true });
        this.started = false;
      }
    }
  }
}
