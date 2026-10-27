import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Application data only. Never store report rows, warehouse codes or credentials.
export const accessNotificationsTable = pgTable("wareiq_access_notifications", {
  id: text("id").primaryKey(),
  recipient: text("recipient").notNull(),
  roleName: text("role_name").notNull(),
  kind: text("kind").notNull(), // reporting | platform
  state: text("state").notNull().default("pending"),
  targetId: text("target_id"),
  platformRole: text("platform_role"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("wareiq_access_notifications_due").on(t.state, t.nextAttemptAt)]);
export const insertAccessNotificationSchema = createInsertSchema(accessNotificationsTable);
export type AccessNotification = typeof accessNotificationsTable.$inferSelect;
