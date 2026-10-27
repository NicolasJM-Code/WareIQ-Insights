import { pgTable, text, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";

export const clientsTable = pgTable("wareiq_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
}, (table) => [uniqueIndex("wareiq_client_name_unique").on(sql`lower(${table.name})`)]);
export const sitesTable = pgTable("wareiq_sites", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => clientsTable.id),
  sourceId: text("source_id").notNull(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
});
export const rolesTable = pgTable("wareiq_roles", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => clientsTable.id),
  name: text("name").notNull(),
  reportIds: text("report_ids").array().notNull().default([]),
  canCreateOwnReports: boolean("can_create_own_reports").notNull().default(false),
}, (table) => [uniqueIndex("wareiq_role_name_unique").on(table.clientId, sql`lower(${table.name})`)]);
export const membersTable = pgTable("wareiq_members", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  clientId: text("client_id").notNull().references(() => clientsTable.id),
  roleId: text("role_id").notNull().references(() => rolesTable.id),
  siteIds: text("site_ids").array().notNull().default([]),
  primarySiteId: text("primary_site_id"),
  active: boolean("active").notNull().default(true),
});
export const ownReportsTable = pgTable("wareiq_own_reports", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  clientId: text("client_id").notNull().references(() => clientsTable.id),
  definition: jsonb("definition").$type<{
    section: string; name: string; description: string; dataset: string; fields: string[]; sourceDefault?: string;
  }>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("wareiq_own_report_name_unique").on(
  table.ownerId, table.clientId, sql`(${table.definition}->>'section')`, sql`lower(${table.definition}->>'name')`,
)]);
export const insertClientSchema = createInsertSchema(clientsTable);
export const insertSiteSchema = createInsertSchema(sitesTable);
export const insertRoleSchema = createInsertSchema(rolesTable);
export const insertMemberSchema = createInsertSchema(membersTable);
export const insertOwnReportSchema = createInsertSchema(ownReportsTable);
