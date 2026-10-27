import type { Request } from "express";
import { accessAuditStore } from "../lib/access-history";

// Record authenticated policy denials only. Do not store arbitrary request
// bodies/paths, unauthenticated traffic, IPs, emails, or provider errors.
export async function auditAccessDenial(req: Request, actorId?: string) {
  if (!actorId || req.method !== "PATCH" || !/\/admin\/users\/[^/]+\/role\/?$/.test(`${req.baseUrl}${req.path}`)) return;
  await accessAuditStore.start({
    actorId, targetId: null, requestedRole: null,
    outcome: "denied", reason: "administrator_required",
  });
}
