import { getAuth, clerkClient } from "@clerk/express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { db, clientsTable, membersTable, rolesTable, sitesTable } from "@workspace/db";
import type { AccessSession } from "@workspace/api-zod";
import { accessReports, accessSectionIds, ownReportSectionsForRole } from "./access-catalog";

export class AccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function identity(req: Request) {
  const { userId } = getAuth(req);
  if (!userId) throw new AccessError(401, "Sign in to continue.");
  let user;
  try { user = await clerkClient.users.getUser(userId); }
  catch { throw new AccessError(503, "Sign-in could not be verified. Try again shortly."); }
  if (user.banned || user.locked) throw new AccessError(403, "This account is not permitted to access WareIQ.");
  const email = user.emailAddresses.find((e) =>
    e.id === user.primaryEmailAddressId && e.verification?.status === "verified")?.emailAddress.toLowerCase();
  return { userId, email, platformAdmin: !!email && user.publicMetadata.role === "admin" };
}
export async function requireAccessAdmin(req: Request) {
  const actor = await identity(req);
  if (!actor.platformAdmin) throw new AccessError(403, "Administrator access is required.");
  return actor;
}
export async function accessFor(req: Request) {
  const actor = await identity(req);
  const [member] = actor.email
    ? await db.select().from(membersTable).where(eq(membersTable.email, actor.email))
    : [];
  const [client] = member ? await db.select().from(clientsTable).where(eq(clientsTable.id, member.clientId)) : [];
  const [role] = member ? await db.select().from(rolesTable).where(and(
    eq(rolesTable.id, member.roleId), eq(rolesTable.clientId, member.clientId))) : [];
  const availableSites = client ? await db.select().from(sitesTable).where(and(
    eq(sitesTable.clientId, client.id), eq(sitesTable.active, true))) : [];
  const sites = availableSites.filter((site) => member?.siteIds.includes(site.id));
  const enabled = !!member?.active && !!client?.active && !!role;
  const status: AccessSession["status"] = !member ? "unassigned" : !enabled ? "disabled" : !sites.length ? "pending_sites" : "active";
  const session: AccessSession = {
    status: actor.platformAdmin && !member ? "active" : status,
    platformAdmin: actor.platformAdmin,
    clientId: client?.id ?? null, clientName: client?.name ?? null,
    clientCompanyNumber: client?.companyNumber ?? null,
    clientAddressLine1: client?.addressLine1 ?? null,
    clientAddressLine2: client?.addressLine2 ?? null,
    clientCity: client?.city ?? null,
    clientRegion: client?.region ?? null,
    clientPostalCode: client?.postalCode ?? null,
    clientCountry: client?.country ?? null,
    clientLogoUrl: client?.logoPath ? `/api/access/clients/${client.id}/logo` : null,
    reportIds: actor.platformAdmin ? accessReports.map((r) => r.id) : enabled ? role!.reportIds : [],
    ownReportSections: enabled
      ? actor.platformAdmin ? [...accessSectionIds] : role ? ownReportSectionsForRole(role) : []
      : [],
    canCreateOwnReports: enabled && (actor.platformAdmin || !!ownReportSectionsForRole(role ?? {
      canCreateOwnReports: false, reportIds: [],
    }).length),
    sites: enabled ? sites : [],
  };
  return { actor, member, role, client, session };
}
export function requireMemberAccess(access: Awaited<ReturnType<typeof accessFor>>) {
  if (!access.member || !access.client || !access.member.active || !access.client.active || !access.role)
    throw new AccessError(403, "Your administrator must approve an active client and role before you can use reports.");
}
