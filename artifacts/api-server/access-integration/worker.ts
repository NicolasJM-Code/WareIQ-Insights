import { pool } from "@workspace/db";
import { accessAuditStore, withRoleLock as commandLock } from "@workspace/db/access-audit";
import { auditedRoleChange } from "../src/lib/audited-role-change";
import { withRoleLock as apiLock } from "../src/lib/role-lock";
import { accessHistoryPage } from "../src/lib/access-history";
import { runRoleCommand } from "../../../scripts/src/role-command";

// This executable is launched with a tiny allowlisted environment. There is no
// Clerk client, network transport, provider key, or real account in this suite.
const kind = process.argv[2];
const failProvider = process.argv[3] === "provider-error";
const user = (id: string, role: string) => ({
  id, firstName: "Synthetic", lastName: "Fixture", banned: false, locked: false,
  primaryEmailAddressId: "email_fixture",
  emailAddresses: [{
    id: "email_fixture", emailAddress: "audit@example.test",
    verification: { status: "verified" },
  }],
  publicMetadata: { role },
});
const target = user("user_target", "unassigned");
const fakeUsers = {
  getUser: async (id: string) => id === "user_actor" ? user(id, "admin") : target,
  getUserList: async () => ({ data: [target], totalCount: 1 }),
  updateUserMetadata: async () => {
    process.send?.({ event: "dispatch" });
    await new Promise<void>((resolve) => process.once("message", () => resolve()));
    if (failProvider) throw new Error("Simulated transport failure after dispatch");
    return user(target.id, "supervisor");
  },
} as unknown as Parameters<typeof auditedRoleChange>[2];

try {
  if (kind === "history") {
    process.send?.({ event: "history", page: await accessHistoryPage() });
  } else {
    // Only observe the committed ID; all writes and locking are production code.
    const store = {
      ...accessAuditStore,
      start: async (entry: Parameters<typeof accessAuditStore.start>[0]) => {
        const id = await accessAuditStore.start(entry);
        process.send?.({ event: "intent", id });
        return id;
      },
    };
    const result = kind === "api"
      ? await auditedRoleChange(store, apiLock, fakeUsers,
        "user_actor", target.id, "supervisor", "unassigned")
      : await runRoleCommand({
        actorId: "operator:integration", email: "audit@example.test", role: "supervisor",
      }, fakeUsers, store, commandLock);
    process.send?.({ event: "success", result });
  }
} catch {
  process.send?.({ event: "failure" });
  // Prove that the same application process can still use the production
  // lock and database after a rejected operation; no fixture error handlers.
  await commandLock(async () => { await pool.query("SELECT 1"); });
  process.send?.({ event: "available" });
} finally {
  await pool.end();
  process.disconnect?.();
}
