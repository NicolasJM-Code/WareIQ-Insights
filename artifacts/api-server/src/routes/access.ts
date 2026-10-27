import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, clientsTable, sitesTable, rolesTable, membersTable, ownReportsTable } from "@workspace/db";
import {
  GetAccessSessionResponse, GetAccessAdminResponse,
  SaveAccessClientBody, SaveAccessClientResponse, SaveAccessRoleBody, SaveAccessRoleResponse,
  SaveAccessUserBody, SaveAccessUserResponse, DeleteAccessEntryParams,
  SaveAccessWarehouseBody, SaveAccessWarehouseResponse,
  SaveAccessOwnReportBody, SaveAccessOwnReportResponse, ListAccessOwnReportsResponse,
  DeleteAccessOwnReportParams, RunAccessReportParams, RunAccessReportBody, RunAccessReportResponse,
  ImportAccessOwnReportsBody, ImportAccessOwnReportsResponse,
  RequestAccessClientLogoUploadBody, RequestAccessClientLogoUploadResponse,
  SaveAccessClientLogoBody, SaveAccessClientLogoResponse,
  RetryAccessNotificationParams, RetryAccessNotificationResponse,
} from "@workspace/api-zod";
import { getAuth } from "@clerk/express";
import { AccessError, accessFor, requireAccessAdmin, requireMemberAccess } from "../lib/reporting-access";
import {
  assertClientLogoFile, cleanupClientLogoBestEffort, getClientLogoFile,
  isClientLogoPath, requestClientLogoUpload,
} from "../lib/client-logo-storage";
import { accessReports, accessSectionIds, ownReportSectionsForRole } from "../lib/access-catalog";
import { reportDefinitionError } from "../lib/own-report-validation";
import { GetAuthSessionResponse, GetSettingsAccessResponse } from "@workspace/api-zod";
import { requireIdentity, requireAdministrator } from "../middlewares/access";
import {
  ACCESS_NOTIFICATION_QUEUE_WARNING_AFTER_SECONDS, getAccessNotificationSummary,
  listConfirmedFailedAccessNotifications, queueAccessNotifications,
  retryConfirmedFailedAccessNotification,
} from "../lib/access-notifications";
import { reportingChangeNotices } from "../lib/reporting-notification-change";

const router: IRouter = Router();
router.get("/auth/session", requireIdentity, (_req, res) => {
  res.json(GetAuthSessionResponse.parse(res.locals.access));
});
router.get("/settings/access", requireIdentity, requireAdministrator, (_req, res) => {
  res.json(GetSettingsAccessResponse.parse({ canAdminister: true }));
});
const handler = (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof AccessError) { res.status(error.status).json({ error: error.message }); return; }
      const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
      if (code === "23505") { res.status(409).json({ error: "This entry already exists. Use a unique name or email." }); return; }
      if (code === "23503") { res.status(409).json({ error: "This entry is still assigned to other records. Reassign them first." }); return; }
      // Never log SQL, request bodies, identity details, or database error text.
      req.log.error({ event: "access_request_failed" }, "Access request failed");
      res.status(503).json({ error: "Access settings are temporarily unavailable. Please retry." });
    }
  };
function parsed<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AccessError(400, "Check all required fields and selections.");
  return result.data;
}
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const routeClientId = (req: Request) => {
  const value = req.params.clientId;
  return Array.isArray(value) ? value[0] : value;
};

router.get("/access/me", handler(async (req, res) => {
  if (!getAuth(req).userId) {
    res.json(GetAccessSessionResponse.parse({ status: "signed_out", platformAdmin: false, canCreateOwnReports: false,
      ownReportSections: [],
      clientId: null, clientName: null, clientCompanyNumber: null, clientAddressLine1: null,
      clientAddressLine2: null, clientCity: null, clientRegion: null, clientPostalCode: null,
      clientCountry: null, clientLogoUrl: null, reportIds: [], sites: [] })); return;
  }
  res.json(GetAccessSessionResponse.parse((await accessFor(req)).session));
}));
router.get("/access/admin", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const [clients, sites, roles, users, notifications] = await Promise.all([
    db.select().from(clientsTable).orderBy(clientsTable.name),
    db.select().from(sitesTable).orderBy(sitesTable.name),
    db.select().from(rolesTable).orderBy(rolesTable.name),
    db.select().from(membersTable).orderBy(membersTable.name),
    listConfirmedFailedAccessNotifications(),
  ]);
  const failedNotifications = notifications.map((notice) => ({
    id: notice.id, recipient: notice.recipient, roleName: notice.role_name,
    kind: notice.kind, createdAt: notice.created_at, attempts: notice.attempts,
  }));
  let notificationSummary: {
    status: "available" | "unavailable";
    queued: number;
    queuedOverThreshold: number;
    oldestQueuedAgeSeconds: number | null;
    queueWarningAfterSeconds: number;
    retrying: number;
    accepted: number;
    failed: number;
  };
  try {
    notificationSummary = { status: "available", ...await getAccessNotificationSummary() };
  } catch {
    req.log.warn({ event: "access_notification_summary_unavailable" }, "Email delivery status unavailable");
    notificationSummary = {
      status: "unavailable",
      queued: 0,
      queuedOverThreshold: 0,
      oldestQueuedAgeSeconds: null,
      queueWarningAfterSeconds: ACCESS_NOTIFICATION_QUEUE_WARNING_AFTER_SECONDS,
      retrying: 0,
      accepted: 0,
      failed: 0,
    };
  }
  res.json(GetAccessAdminResponse.parse({
    clients, sites,
    roles: roles.map((role) => {
      const ownReportSections = ownReportSectionsForRole(role);
      return { ...role, ownReportSections, canCreateOwnReports: ownReportSections.length > 0 };
    }),
    users, reports: accessReports, notificationSummary, failedNotifications,
  }));
}));
router.post("/access/notifications/:notificationId/retry", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const params = parsed(RetryAccessNotificationParams, req.params);
  const queued = await retryConfirmedFailedAccessNotification(params.notificationId);
  if (!queued) throw new AccessError(409, "Only provider-confirmed failed notices can be retried.");
  res.json(RetryAccessNotificationResponse.parse({ status: "queued" }));
}));
router.post("/access/clients", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const input = parsed(SaveAccessClientBody.strict(), req.body);
  const values = {
    name: input.name.trim(), companyNumber: input.companyNumber.trim(),
    addressLine1: input.addressLine1.trim(), addressLine2: input.addressLine2.trim(),
    city: input.city.trim(), region: input.region.trim(), postalCode: input.postalCode.trim(),
    country: input.country.trim(), active: input.active,
  };
  if (!values.name) throw new AccessError(400, "Client name is required.");
  if (Object.values(values).some((value) => typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)))
    throw new AccessError(400, "Client details cannot contain control characters.");
  const [result] = input.id
    ? await db.update(clientsTable).set(values).where(eq(clientsTable.id, input.id)).returning()
    : await db.insert(clientsTable).values({ id: randomUUID(), ...values }).returning();
  if (!result) throw new AccessError(404, "Client not found.");
  res.json(SaveAccessClientResponse.parse(result));
}));
router.post("/access/clients/:clientId/logo-upload", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const input = parsed(RequestAccessClientLogoUploadBody.strict(), req.body);
  const clientId = routeClientId(req);
  if (!isUuid(clientId))
    throw new AccessError(400, "Choose a valid client.");
  const [client] = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) throw new AccessError(404, "Client not found.");
  const maxLogoSize = 2 * 1024 * 1024;
  if (input.size > maxLogoSize || !["image/png", "image/jpeg", "image/webp"].includes(input.contentType))
    throw new AccessError(400, "Choose a PNG, JPEG, or WebP logo smaller than 2 MB.");
  const result = await requestClientLogoUpload(clientId, input.contentType);
  res.json(RequestAccessClientLogoUploadResponse.parse(result));
}));
router.put("/access/clients/:clientId/logo", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const input = parsed(SaveAccessClientLogoBody.strict(), req.body);
  const clientId = routeClientId(req);
  if (!isUuid(clientId))
    throw new AccessError(400, "Choose a valid client.");
  if (input.objectPath !== null) {
    if (!isClientLogoPath(clientId, input.objectPath))
      throw new AccessError(400, "The uploaded logo does not belong to this client.");
    try { await assertClientLogoFile(clientId, input.objectPath); }
    catch { throw new AccessError(400, "The uploaded logo could not be verified. Please upload it again."); }
  }
  const saved = await db.transaction(async (tx) => {
    const [current] = await tx.select({ logoPath: clientsTable.logoPath }).from(clientsTable)
      .where(eq(clientsTable.id, clientId)).for("update");
    if (!current) return null;
    const [result] = await tx.update(clientsTable).set({ logoPath: input.objectPath })
      .where(eq(clientsTable.id, clientId)).returning();
    if (!result) return null;
    return { previousPath: current.logoPath, result };
  });
  if (!saved) throw new AccessError(404, "Client not found.");
  if (saved.previousPath && saved.previousPath !== input.objectPath) {
    await cleanupClientLogoBestEffort(clientId, saved.previousPath, async (objectPath) => {
      const [reference] = await db.select({ id: clientsTable.id }).from(clientsTable)
        .where(eq(clientsTable.logoPath, objectPath)).limit(1);
      return Boolean(reference);
    }, () => req.log.warn(
      { event: "client_logo_cleanup_failed" },
      "Unable to remove an unused client logo",
    ));
  }
  res.json(SaveAccessClientLogoResponse.parse(saved.result));
}));
router.get("/access/clients/:clientId/logo", handler(async (req, res) => {
  const access = await accessFor(req);
  const clientId = routeClientId(req);
  if (!isUuid(clientId))
    throw new AccessError(404, "Client logo not found.");
  if (!access.actor.platformAdmin) {
    requireMemberAccess(access);
    if (access.client?.id !== clientId)
      throw new AccessError(403, "You cannot view another client's logo.");
  }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client?.logoPath || !isClientLogoPath(clientId, client.logoPath))
    throw new AccessError(404, "Client logo not found.");
  let file;
  let metadata;
  try {
    file = await getClientLogoFile(clientId, client.logoPath);
    [metadata] = await file.getMetadata();
  }
  catch { throw new AccessError(404, "Client logo not found."); }
  const contentType = String(metadata.contentType ?? "");
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType) ||
      !metadata.size || Number(metadata.size) > 2 * 1024 * 1024)
    throw new AccessError(404, "Client logo not found.");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  const stream = file.createReadStream();
  stream.on("error", () => {
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  });
  stream.pipe(res);
}));
router.post("/access/warehouses", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const input = parsed(SaveAccessWarehouseBody.strict(), req.body);
  const name = input.name.trim();
  const sourceId = input.sourceId.trim();
  if (!name || !sourceId || /[\u0000-\u001f\u007f]/.test(name + sourceId))
    throw new AccessError(400, "Warehouse name and WMS warehouse code are required and cannot contain control characters.");
  const result = await db.transaction(async (tx) => {
    const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, input.clientId)).for("update");
    if (!client) throw new AccessError(400, "Choose an existing client.");
    if (!input.id && !client.active) throw new AccessError(400, "Enable the client before adding a warehouse.");
    const values = {
      name, active: input.active,
      addressLine1: input.addressLine1.trim(), addressLine2: input.addressLine2.trim(),
      city: input.city.trim(), region: input.region.trim(), postalCode: input.postalCode.trim(),
      country: input.country.trim(), contactPhone: input.contactPhone.trim(),
    };
    if (Object.values(values).some((value) => typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)))
      throw new AccessError(400, "Warehouse details cannot contain control characters.");
    if (input.id) {
      const [warehouse] = await tx.select().from(sitesTable).where(eq(sitesTable.id, input.id)).for("update");
      if (!warehouse) throw new AccessError(404, "Warehouse not found.");
      // Tenant and source identity are immutable: existing assignments must never
      // acquire access to a different client's or operational warehouse's records.
      if (warehouse.clientId !== input.clientId || warehouse.sourceId !== sourceId)
        throw new AccessError(409, "A warehouse's client and WMS code cannot be changed. Create a separate warehouse instead.");
      const [updated] = await tx.update(sitesTable).set(values).where(eq(sitesTable.id, warehouse.id)).returning();
      return updated;
    }
    const [created] = await tx.insert(sitesTable).values({
      id: randomUUID(), clientId: client.id, sourceId, ...values,
    }).returning();
    return created;
  });
  res.json(SaveAccessWarehouseResponse.parse(result));
}));
router.post("/access/roles", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const input = parsed(SaveAccessRoleBody.strict(), req.body);
  const ids = new Set(accessReports.map((r) => r.id));
  if (input.reportIds.some((id) => !ids.has(id)) || new Set(input.reportIds).size !== input.reportIds.length)
    throw new AccessError(400, "Select only known report names, without duplicates.");
  if (input.ownReportSections.some((section) => !accessSectionIds.includes(section as typeof accessSectionIds[number]))
    || new Set(input.ownReportSections).size !== input.ownReportSections.length)
    throw new AccessError(400, "Choose valid, unique sections for own reports.");
  if (!input.name.trim()) throw new AccessError(400, "Role name is required.");
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, input.clientId));
  if (!client) throw new AccessError(400, "Choose an existing client.");
  const values = { clientId: input.clientId, name: input.name.trim(), reportIds: input.reportIds,
    canCreateOwnReports: input.ownReportSections.length > 0, ownReportSections: input.ownReportSections };
  // A role's client cannot be changed while it may be assigned to users.
  const result = await db.transaction(async (tx) => {
    const [before] = input.id ? await tx.select().from(rolesTable).where(and(
      eq(rolesTable.id, input.id), eq(rolesTable.clientId, input.clientId))).for("update") : [];
    if (input.id && !before) throw new AccessError(404, "Role not found for this client. Create a new role to use a different client.");
    const [saved] = input.id
      ? await tx.update(rolesTable).set(values).where(eq(rolesTable.id, input.id)).returning()
      : await tx.insert(rolesTable).values({ id: randomUUID(), ...values }).returning();
    const changed = before && (before.name !== values.name || before.canCreateOwnReports !== values.canCreateOwnReports ||
      JSON.stringify([...(before.ownReportSections ?? [])].sort()) !== JSON.stringify([...values.ownReportSections].sort()) ||
      JSON.stringify([...before.reportIds].sort()) !== JSON.stringify([...values.reportIds].sort()));
    const members = changed ? await tx.select().from(membersTable).where(and(
      eq(membersTable.roleId, saved!.id), eq(membersTable.active, true))) : [];
    const notification = await queueAccessNotifications(tx, members.map((m) => ({
      recipient: m.email, roleName: values.name, kind: "reporting" as const, targetId: m.id,
    })));
    return { ...saved!, notification };
  });
  res.json(SaveAccessRoleResponse.parse(result));
}));
router.post("/access/users", handler(async (req, res) => {
  await requireAccessAdmin(req);
  const input = parsed(SaveAccessUserBody.strict(), req.body);
  const [role] = await db.select().from(rolesTable).where(and(eq(rolesTable.id, input.roleId), eq(rolesTable.clientId, input.clientId)));
  if (!role) throw new AccessError(400, "Choose a role belonging to this client.");
  const sites = await db.select().from(sitesTable).where(and(eq(sitesTable.clientId, input.clientId), eq(sitesTable.active, true)));
  if (new Set(input.siteIds).size !== input.siteIds.length || input.siteIds.some((id) => !sites.some((site) => site.id === id)))
    throw new AccessError(400, "All sites must be active sites belonging to the selected client.");
  if ((input.siteIds.length > 0 && !input.primarySiteId) ||
      (input.primarySiteId !== null && !input.siteIds.includes(input.primarySiteId)))
    throw new AccessError(400, "Choose a primary site from this user's selected sites.");
  const { id, ...data } = input;
  const values = { ...data, email: data.email.trim().toLowerCase(), name: data.name.trim() };
  if (!values.name) throw new AccessError(400, "User name is required.");
  const result = await db.transaction(async (tx) => {
    const [before] = id ? await tx.select().from(membersTable).where(eq(membersTable.id, id)).for("update") : [];
    if (id && !before) throw new AccessError(404, "User access record not found.");
    const [saved] = id
      ? await tx.update(membersTable).set(values).where(eq(membersTable.id, id)).returning()
      : await tx.insert(membersTable).values({ id: randomUUID(), ...values }).returning();
    const notification = await queueAccessNotifications(tx, reportingChangeNotices(before, saved, role.name));
    return { ...saved!, notification };
  });
  res.json(SaveAccessUserResponse.parse(result));
}));
router.delete(["/access/clients/:id", "/access/roles/:id", "/access/users/:id"], handler(async (req, res) => {
  await requireAccessAdmin(req);
  const { entity, id } = parsed(DeleteAccessEntryParams, { ...req.params, entity: req.path.split("/")[2] });
  if (entity === "users") {
    const notification = await db.transaction(async (tx) => {
      const [deleted] = await tx.delete(membersTable).where(eq(membersTable.id, id)).returning();
      if (!deleted) throw new AccessError(404, "Entry not found.");
      return queueAccessNotifications(tx, reportingChangeNotices(deleted, undefined, ""));
    });
    res.setHeader("X-Access-Notification", notification);
    res.sendStatus(204);
    return;
  }
  const table = entity === "clients" ? clientsTable : entity === "roles" ? rolesTable : membersTable;
  const deleted = await db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
  if (!deleted.length) throw new AccessError(404, "Entry not found.");
  res.sendStatus(204);
}));

async function ownAccess(req: Request) {
  const access = await accessFor(req);
  requireMemberAccess(access);
  if (!access.session.ownReportSections.length) throw new AccessError(403, "Your role does not allow creating or managing own reports.");
  return access;
}
router.get("/access/own-reports", handler(async (req, res) => {
  const access = await ownAccess(req);
  const rows = await db.select().from(ownReportsTable).where(and(
    eq(ownReportsTable.ownerId, access.actor.userId), eq(ownReportsTable.clientId, access.member!.clientId)));
  const reports = rows.filter((row) => access.session.ownReportSections.includes(row.definition.section)).map((row) => ({
    id: row.id, ...row.definition, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }));
  res.json(ListAccessOwnReportsResponse.parse(reports));
}));
router.post("/access/own-reports", handler(async (req, res) => {
  const access = await ownAccess(req);
  const input = parsed(SaveAccessOwnReportBody.strict(), req.body);
  const invalid = reportDefinitionError(input, access.session.reportIds, access.session.ownReportSections);
  if (invalid) throw new AccessError(invalid.status, invalid.message);
  const { id, ...definition } = input;
  const clientId = access.member!.clientId;
  const ownerId = access.actor.userId;
  const duplicates = await db.select({ id: ownReportsTable.id }).from(ownReportsTable).where(and(
    eq(ownReportsTable.ownerId, ownerId), eq(ownReportsTable.clientId, clientId),
    sql`${ownReportsTable.definition}->>'section' = ${definition.section}`,
    sql`lower(${ownReportsTable.definition}->>'name') = ${definition.name.trim().toLowerCase()}`,
    ...(id ? [ne(ownReportsTable.id, id)] : []),
  ));
  if (duplicates.length) throw new AccessError(409, "Another own report in this section uses this name.");
  definition.name = definition.name.trim();
  const [row] = id
    ? await db.update(ownReportsTable).set({ definition, updatedAt: new Date() }).where(and(
      eq(ownReportsTable.id, id), eq(ownReportsTable.ownerId, ownerId), eq(ownReportsTable.clientId, clientId))).returning()
    : await db.insert(ownReportsTable).values({ id: randomUUID(), ownerId, clientId, definition }).returning();
  if (!row) throw new AccessError(404, "Own report not found in your account.");
  res.json(SaveAccessOwnReportResponse.parse({ id: row.id, ...row.definition, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
}));
router.post("/access/own-reports/import", handler(async (req, res) => {
  const access = await ownAccess(req);
  const input = parsed(ImportAccessOwnReportsBody.strict(), req.body);
  const ownerId = access.actor.userId;
  const clientId = access.member!.clientId;
  if (input.expectedOwnerId !== ownerId || input.expectedClientId !== clientId)
    throw new AccessError(409, "Your account or client changed. Close the import and preview again.");
  const names = new Set<string>();
  const definitions = input.reports.map((_report, index) => {
    // Reject supplied ownership, legacy IDs, timestamps, or other hidden properties.
    const definition = parsed(SaveAccessOwnReportBody.omit({ id: true }).strict(),
      (req.body as { reports: unknown[] }).reports[index]);
    const invalid = reportDefinitionError(definition, access.session.reportIds, access.session.ownReportSections);
    if (invalid) throw new AccessError(invalid.status, invalid.message);
    definition.name = definition.name.trim();
    const key = JSON.stringify([definition.section, definition.name.toLowerCase()]);
    if (names.has(key)) throw new AccessError(409, "Selected reports have duplicate names in the same section. Rename or deselect them.");
    names.add(key);
    return definition;
  });
  // The unique index covers existing names and concurrent imports. One transaction
  // ensures a rejected selection never leaves an invisible, partially imported batch.
  const reports = await db.transaction(async (tx) => {
    const rows = await tx.insert(ownReportsTable).values(definitions.map((definition) => ({
      id: randomUUID(), ownerId, clientId, definition,
    }))).returning();
    return rows.map((row) => ({ id: row.id, ...row.definition,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  });
  res.json(ImportAccessOwnReportsResponse.parse(reports));
}));
router.delete("/access/own-reports/:id", handler(async (req, res) => {
  const access = await ownAccess(req);
  const { id } = parsed(DeleteAccessOwnReportParams, req.params);
  const [row] = await db.select().from(ownReportsTable).where(and(eq(ownReportsTable.id, id),
    eq(ownReportsTable.ownerId, access.actor.userId), eq(ownReportsTable.clientId, access.member!.clientId)));
  if (!row) throw new AccessError(404, "Own report not found.");
  if (!access.session.ownReportSections.includes(row.definition.section)) throw new AccessError(403, "This section is no longer permitted.");
  await db.delete(ownReportsTable).where(eq(ownReportsTable.id, row.id));
  res.sendStatus(204);
}));
router.post("/access/reports/:id/run", handler(async (req, res) => {
  const access = await accessFor(req);
  requireMemberAccess(access);
  const { id } = parsed(RunAccessReportParams, req.params);
  const { siteId } = parsed(RunAccessReportBody.strict(), req.body);
  if (!access.session.sites.some((site) => site.id === siteId))
    throw new AccessError(403, "This site is not assigned to you.");
  if (!access.session.reportIds.includes(id)) {
    const [own] = await db.select().from(ownReportsTable).where(and(eq(ownReportsTable.id, id),
      eq(ownReportsTable.ownerId, access.actor.userId), eq(ownReportsTable.clientId, access.member!.clientId)));
    if (!own || !access.session.ownReportSections.includes(own.definition.section))
      throw new AccessError(403, "Your role does not grant access to this report.");
  }
  // No operational reads before the WMS source mapping has been approved.
  res.json(RunAccessReportResponse.parse({ status: "not_connected", message: "Access is authorised, but this report cannot run until the WMS database and approved report source mapping are connected." }));
}));

export default router;
