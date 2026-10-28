import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Bounded diagnostic state only: no payload, account, signature or signing key.
export const captureDiagnosticsTable = pgTable("capture_delivery_diagnostics", {
  environment: text("environment").notNull(),
  instanceId: text("instance_id").notNull(),
  attemptId: uuid("attempt_id").notNull(),
  status: text("status", { enum: ["pending", "failed", "succeeded"] }).notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.environment, t.instanceId] })]);
