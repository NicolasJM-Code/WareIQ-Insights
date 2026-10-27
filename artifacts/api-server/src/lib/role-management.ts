import type { clerkClient } from "@clerk/express";
import { appRole, verifiedPrimaryEmail, type AppRole } from "./access-policy";

type User = Awaited<ReturnType<typeof clerkClient.users.getUser>>;
type UserDirectory = Pick<typeof clerkClient.users, "getUser" | "getUserList" | "updateUserMetadata">;

export class AccessConflict extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "policy_denied") { super(message); }
}

export function accessUser(user: User) {
  return {
    id: user.id,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unnamed account",
    email: user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? "",
    emailVerified: verifiedPrimaryEmail(user),
    role: appRole(user.publicMetadata.role),
    restricted: user.banned || user.locked,
  };
}

// Must run under the shared application database advisory lock. Re-read the
// actor INSIDE the lock: an administrator waiting for it may have been revoked.
export async function changeRole(
  users: UserDirectory,
  actorId: string,
  targetId: string,
  role: AppRole,
  expectedRole: AppRole,
  observe?: {
    previous: (role: AppRole) => Promise<void>;
    beforeWrite: () => void;
  },
  notifications?: {
    prepare: (email: string, targetId: string, role: AppRole) => Promise<string | null>;
    confirm: (id: string) => Promise<void>;
  },
) {
  const actor = await users.getUser(actorId);
  if (actor.banned || actor.locked || !verifiedPrimaryEmail(actor) || appRole(actor.publicMetadata.role) !== "admin") {
    throw new AccessConflict(403, "Administrator access is required.", "administrator_required");
  }
  // No self-service role changes, including a last administrator's demotion.
  if (actorId === targetId) {
    throw new AccessConflict(409, "You cannot change your own role. Ask another administrator.", "self_change_denied");
  }
  const target = await users.getUser(targetId);
  const previous = appRole(target.publicMetadata.role);
  await observe?.previous(previous);
  if (previous !== expectedRole) {
    throw new AccessConflict(409, "This account's role changed. Refresh the account list before trying again.", "stale_role");
  }
  if (role !== "unassigned" && (target.banned || target.locked || !verifiedPrimaryEmail(target))) {
    throw new AccessConflict(403, "Access can only be granted to an unrestricted account with a verified primary email.", "target_restricted");
  }
  if (previous === role) return accessUser(target);
  if (previous === "admin" && role !== "admin") {
    // Clerk metadata cannot be filtered server-side. Scan ALL pages and count
    // only usable administrators; never assume the displayed page is complete.
    let offset = 0;
    let hasOtherAdministrator = false;
    while (true) {
      const page = await users.getUserList({ limit: 100, offset, orderBy: "+created_at" });
      if (page.data.some((u) => u.id !== targetId && !u.banned && !u.locked &&
          verifiedPrimaryEmail(u) && appRole(u.publicMetadata.role) === "admin")) {
        hasOtherAdministrator = true;
        break;
      }
      offset += page.data.length;
      if (offset >= page.totalCount) break;
      if (!page.data.length) throw new Error("Incomplete account listing");
    }
    if (!hasOtherAdministrator) {
      throw new AccessConflict(409, "The last active administrator cannot be removed. Approve another administrator first.", "last_administrator");
    }
  }

  // The email event is staged before Clerk and confirmed after the returned
  // role is verified. Outbox failures never block an access mutation.
  let notificationId: string | null = null;
  let notificationStatus: "queued" | "failed" | "not_needed" = "not_needed";
  if (notifications && verifiedPrimaryEmail(target)) {
    notificationStatus = "failed";
    try {
      notificationId = await notifications.prepare(accessUser(target).email, targetId, role);
      if (notificationId) notificationStatus = "queued";
    } catch { /* Notification setup must not block an access change. */ }
  }
  // The audit intent was committed independently before issuing Clerk's write.
  observe?.beforeWrite();
  const updated = await users.updateUserMetadata(targetId, {
    publicMetadata: { role },
    ...(notificationId ? { privateMetadata: { wareiqRoleNotificationId: notificationId } } : {}),
  });
  if (appRole(updated.publicMetadata.role) !== role) {
    throw new Error("Role update was not confirmed");
  }
  if (notificationId) {
    try { await notifications!.confirm(notificationId); }
    catch { /* The durable confirming row can be reconciled by the worker. */ }
  }
  return {
    ...accessUser(updated),
    ...(notifications ? { notification: notificationStatus } : {}),
  };
}
