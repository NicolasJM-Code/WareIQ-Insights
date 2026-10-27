import { AccessConflict, changeRole } from "./role-management";
import type { AppRole } from "./access-policy";

export type AuditOutcome = "succeeded" | "unchanged" | "denied" | "failed" | "unconfirmed";
export type AuditStart = {
  actorId: string;
  targetId: string | null;
  requestedRole: AppRole | null;
  outcome?: AuditOutcome;
  reason?: string;
};
export interface AccessAuditStore {
  start: (entry: AuditStart) => Promise<string>;
  previous: (id: string, role: AppRole) => Promise<void>;
  finish: (id: string, outcome: AuditOutcome, reason: string, resultingRole?: AppRole) => Promise<void>;
}

// The intent is committed independently BEFORE contacting Clerk. The role lock's
// transaction must never roll back this evidence if the provider call fails.
export async function auditedRoleChange(
  store: AccessAuditStore,
  lock: <T>(operation: () => Promise<T>) => Promise<T>,
  users: Parameters<typeof changeRole>[0],
  actorId: string,
  targetId: string,
  role: AppRole,
  expectedRole: AppRole,
) {
  // Only plausible provider IDs are retained, never arbitrary path text.
  const safeTargetId = /^user_[a-zA-Z0-9_]{1,195}$/.test(targetId) ? targetId : null;
  const id = await store.start({ actorId, targetId: safeTargetId, requestedRole: role });
  let writeAttempted = false;
  let previous: AppRole | undefined;
  let updated: Awaited<ReturnType<typeof changeRole>>;
  try {
    updated = await lock(() => changeRole(users, actorId, targetId, role, expectedRole, {
      previous: async (value) => {
        await store.previous(id, value);
        previous = value;
      },
      beforeWrite: () => { writeAttempted = true; },
    }));
  } catch (error) {
    const outcome = writeAttempted ? "unconfirmed" : error instanceof AccessConflict ? "denied" : "failed";
    const reason = writeAttempted ? "provider_outcome_unknown"
      : error instanceof AccessConflict ? error.code : "change_not_started";
    // If this write also fails, the committed unconfirmed intent remains. Do
    // not return a definitive policy/provider result without durable evidence.
    await store.finish(id, outcome, reason);
    // Even a provider 404 after dispatch is not proof that nothing changed.
    // Keep transport status codes from becoming a definitive "not found" UI.
    if (writeAttempted) throw new Error("Provider outcome is unconfirmed");
    throw error;
  }
  await store.finish(id, previous === role ? "unchanged" : "succeeded",
    previous === role ? "already_assigned" : "role_confirmed", updated.role);
  return updated;
}
