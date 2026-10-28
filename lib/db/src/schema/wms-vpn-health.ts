import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Monitoring metadata only: never connector tokens, database credentials or profiles.
export const wmsVpnHealthTable = pgTable("wareiq_wms_vpn_health", {
  id: text("id").primaryKey(),
  configKey: text("config_key").notNull(),
  state: jsonb("state").notNull(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
});
