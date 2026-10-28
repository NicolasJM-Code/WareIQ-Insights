import { integer, pgTable, text } from "drizzle-orm/pg-core";

// Operator health state only; never store notification or recipient data here.
export const accessNotificationCleanupHealthTable = pgTable("wareiq_access_notification_cleanup_health", {
  id: text("id").primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
});
