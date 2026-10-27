import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export type AppRole = "admin" | "supervisor" | "unassigned";

export function appRole(value: unknown): AppRole {
  return value === "admin" || value === "supervisor" ? value : "unassigned";
}

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
      res.status(403).json({ error: "This account is not permitted to access WareIQ." });
      return;
    }
    const role = appRole(user.publicMetadata.role);
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

export const requireAdministrator: RequestHandler = (_req, res, next) => {
  if (!res.locals.access?.canAdminister) {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
};
