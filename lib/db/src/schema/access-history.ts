import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
  // Nullable for Settings/recovery records. Signed provider observations are
  // independent evidence, never confirmations of an existing attempt.
  providerEventId: text("provider_event_id"),
  providerInstanceId: text("provider_instance_id"),
  providerEnvironment: text("provider_environment"),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true, precision: 3 }),
  outcome: text("outcome").notNull().default("unconfirmed"),
  reason: text("reason").notNull().default("confirmation_pending"),
}, (t) => [
  index("access_change_history_page_idx").on(t.createdAt, t.id),
  uniqueIndex("access_change_history_provider_event_idx")
    .on(t.providerEnvironment, t.providerInstanceId, t.providerEventId),
]);
