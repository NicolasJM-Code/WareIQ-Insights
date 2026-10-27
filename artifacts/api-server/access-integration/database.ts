import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  readonly pool = new Pool({
    connectionString: this.connectionString,
    password: "",
    max: 4,
    connectionTimeoutMillis: 2_000,
  });
  private started = false;
  private stopped = false;

  private run(command: string, args: string[]) {
    execFileSync(command, args, {
      env: { PATH: process.env.PATH, HOME: this.directory, LANG: "C", LC_ALL: "C" },
      stdio: "pipe",
      timeout: 20_000,
    });
  }

  async start() {
    try {
      this.run("initdb", ["-D", this.data, "-U", "audit_test",
        "--auth-local=trust", "--auth-host=reject", "--no-locale"]);
      this.run("pg_ctl", ["-D", this.data, "-l", join(this.directory, "postgres.log"),
        "-o", `-k ${this.directory} -c listen_addresses=''`, "-w", "start"]);
      this.started = true;
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
