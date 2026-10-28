import { jsonb, pgTable, text } from "drizzle-orm/pg-core";

// Shared, bounded rate-limit state for warehouse connection checks.
export const wmsConnectionTestLimiterTable = pgTable("wareiq_wms_connection_test_limiter", {
  id: text("id").primaryKey(),
  state: jsonb("state").notNull(),
});
