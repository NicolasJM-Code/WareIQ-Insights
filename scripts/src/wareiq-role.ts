import { createClerkClient } from "@clerk/backend";
import { parseRoleCommand, runRoleCommand } from "./role-command";

// Explicit owner-operated grant/revoke command; never called during startup.
// No raw provider/database errors or input values are printed.
async function main() {
  const key = process.env.CLERK_SECRET_KEY;
  const input = parseRoleCommand(process.argv.slice(2), key?.startsWith("sk_live_") ?? false);
  if (!key) throw new Error("Managed authentication is not configured.");
  if (!process.env.DATABASE_URL) throw new Error("The application audit database must be configured.");
  const { accessAuditStore, withRoleLock } = await import("@workspace/db/access-audit");
  const { pool } = await import("@workspace/db");
  try {
    const result = await runRoleCommand(input, createClerkClient({ secretKey: key }).users, accessAuditStore, withRoleLock);
    console.info(result.changed ? "WareIQ role confirmed. The next API request uses the new permissions."
      : "The account already has this role; no provider update was needed.");
    console.info(`Access history record: ${result.id}`);
  } catch {
    // Includes final persistence failure after a confirmed provider response.
    console.error("Command did not complete. The role may have changed. Check platform access history and current permissions before retrying.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error("Command could not start. Require --email, --role, --operator-id and --confirm-ownership; live environments also require --confirm-production. Check managed authentication and the application audit database. No credentials should be passed on the command line.");
  process.exitCode = 1;
});
