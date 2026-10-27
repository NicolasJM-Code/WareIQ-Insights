import { pool } from "@workspace/db";

// Application DB only — never connect to the operational WMS for access changes.
// Transaction-scoped PostgreSQL lock serializes mutations across API instances
// and releases automatically on rollback/disconnect. No schema change required.
export async function withRoleLock<T>(operation: () => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SELECT pg_advisory_xact_lock(174983, 1)");
    const result = await operation();
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
