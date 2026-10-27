import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// No provider payloads, email addresses, request bodies, or WMS data.
export const accessHistoryTable = pgTable("access_change_history", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // user_* = authenticated Settings actor; operator:* = terminal-attested
  // operator, not a verified Clerk identity. Never infer a dashboard actor.
  actorId: text("actor_id").notNull(),
  targetId: text("target_id"),
  previousRole: text("previous_role"),
  requestedRole: text("requested_role"),
  resultingRole: text("resulting_role"),
  outcome: text("outcome").notNull().default("unconfirmed"),
  reason: text("reason").notNull().default("confirmation_pending"),
}, (t) => [index("access_change_history_page_idx").on(t.createdAt, t.id)]);
