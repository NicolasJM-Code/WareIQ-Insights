import { pool } from "@workspace/db";
import { getAccessNotificationSummary } from "../src/lib/access-notifications";

process.on("message", async (message: { action: string }) => {
  if (message.action !== "summary") return;
  try {
    process.send?.({ event: "summary", summary: await getAccessNotificationSummary() });
  } catch {
    process.send?.({ event: "summary", error: true });
  }
});

process.on("disconnect", () => {
  void pool.end().then(() => process.exit(0));
});

process.send?.({ event: "ready" });
