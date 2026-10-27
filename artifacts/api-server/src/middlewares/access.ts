import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { appRole, verifiedPrimaryEmail } from "../lib/access-policy";
import { auditAccessDenial } from "./audit-access-denial";
export { appRole, type AppRole } from "../lib/access-policy";

// A valid signature alone does not prove the session is still active: an issued
// JWT can remain cryptographically valid after provider-side revocation.
// Run once before BOTH membership and legacy routes, without caching approvals.
export const requireActiveSession: RequestHandler = async (req, res, next) => {
  const { userId, sessionId } = getAuth(req);
  if (!userId) { next(); return; } // Each route owns its signed-out policy.
  res.setHeader("Cache-Control", "private, no-store");
  if (!sessionId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  try {
    const session = await clerkClient.sessions.getSession(sessionId);
    if (session.status !== "active" || session.userId !== userId) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    next();
  } catch (error) {
    if ((error as { status?: number })?.status === 404) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    req.log.warn("Unable to verify active session");
    res.status(503).json({ error: "Unable to verify access. Try again shortly." });
  }
};

// Read current, server-owned metadata on EVERY request. Do not trust role headers,
// unsafeMetadata, browser storage, or stale session claims after a role revocation.
export const requireIdentity: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  try {
    const user = await clerkClient.users.getUser(userId);
    if (user.banned || user.locked) {
      await auditAccessDenial(req, userId);
      res.status(403).json({ error: "This account is not permitted to access WareIQ." });
      return;
    }
    const role = verifiedPrimaryEmail(user) ? appRole(user.publicMetadata.role) : "unassigned";
    res.locals.access = {
      userId,
      role,
      canReport: role === "admin" || role === "supervisor",
      canAdminister: role === "admin",
    };
    next();
  } catch {
    // Never send provider errors or sensitive data to the client/log.
    req.log.warn("Unable to verify account permissions");
    res.status(503).json({ error: "Unable to verify access. Try again shortly." });
  }
};

export const requireReporter: RequestHandler = (_req, res, next) => {
  if (!res.locals.access?.canReport) {
    res.status(403).json({ error: "A supervisor or administrator role is required." });
    return;
  }
  next();
};

export const requireAdministrator: RequestHandler = async (req, res, next) => {
  if (!res.locals.access?.canAdminister) {
    try {
      await auditAccessDenial(req, res.locals.access?.userId);
    } catch {
      res.status(503).json({ error: "Access history is unavailable. No change was attempted." });
      return;
    }
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
};
