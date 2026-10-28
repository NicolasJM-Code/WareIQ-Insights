import { ReplitConnectors } from "@replit/connectors-sdk";
import { clerkClient } from "@clerk/express";
import { pool } from "@workspace/db";
import { withRoleLock } from "../src/lib/role-lock";
import {
  deliverAccessNotifications,
  getAccessNotificationSummary,
  listUncertainAccessNotifications,
} from "../src/lib/access-notifications";

// Only the two external provider boundaries are synthetic. Database clients,
// error handling, locking, delivery, and read-back all use production code.
// The credential-free Clerk proxy creates a client on each property read and
// rejects assignment. Define the synthetic boundary on its otherwise-empty target.
Object.defineProperty(clerkClient, "users", {
  value: {
    getUser: async () => ({
      publicMetadata: { role: "supervisor" },
      privateMetadata: { wareiqRoleNotificationId: "disconnect-notice" },
    }),
  },
});

let resume: (() => void) | undefined;
let sends = 0;
ReplitConnectors.prototype.createProxyFetch = () => async (_url, options) => {
  sends++;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  process.send?.({
    event: "dispatch", sends,
    key: new Headers(options?.headers).get("Idempotency-Key"),
  });
  await gate;
  if (process.argv[2] === "transport-error") throw new Error("Synthetic ambiguous delivery");
  return new Response(JSON.stringify({ id: "synthetic-provider-id" }), { status: 200 });
};

process.on("message", async (message: { action: string; requestId: number }) => {
  if (message.action === "resume") {
    resume?.();
    return;
  }
  try {
    let result: unknown;
    if (message.action === "deliver") {
      await deliverAccessNotifications();
      result = { sends };
    } else if (message.action === "available") {
      result = await withRoleLock(async () => (await pool.query("SELECT 1 AS available")).rows[0]);
    } else if (message.action === "read") {
      result = {
        summary: await getAccessNotificationSummary(),
        uncertain: await listUncertainAccessNotifications(),
      };
    } else throw new Error("Unknown action");
    process.send?.({ requestId: message.requestId, result });
  } catch {
    process.send?.({ requestId: message.requestId, error: true });
  }
});
process.on("disconnect", () => { void pool.end().then(() => process.exit(0)); });
process.send?.({ event: "ready" });
