import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

// Application data only. Never store report rows, warehouse codes or credentials.
// Sent and cancelled records are eligible for deletion after 90 days; pending and
// failed records remain available to delivery retry and administrator recovery.
export const accessNotificationsTable = pgTable("wareiq_access_notifications", {
  id: text("id").primaryKey(),
  recipient: text("recipient").notNull(),
  roleName: text("role_name").notNull(),
  kind: text("kind").notNull(), // reporting | platform | vpn_outage | vpn_recovery
  state: text("state").notNull().default("pending"),
  targetId: text("target_id"),
  platformRole: text("platform_role"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("wareiq_access_notifications_due").on(t.state, t.nextAttemptAt),
  index("wareiq_access_notifications_confirmed_failed_page")
    .on(t.createdAt, t.id)
    .where(sql`${t.state} = 'confirmed_failed'`),
]);
export const insertAccessNotificationSchema = createInsertSchema(accessNotificationsTable);
export type AccessNotification = typeof accessNotificationsTable.$inferSelect;
