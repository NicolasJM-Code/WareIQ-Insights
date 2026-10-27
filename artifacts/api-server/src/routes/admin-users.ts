import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import {
  ListAccessUsersQueryParams, ListAccessUsersResponse,
  ChangeAccessRoleParams, ChangeAccessRoleBody, ChangeAccessRoleResponse,
  ListAccessHistoryQueryParams, ListAccessHistoryResponse,
} from "@workspace/api-zod";
import { AccessConflict, accessUser } from "../lib/role-management";
import { withRoleLock } from "../lib/role-lock";
import { auditedRoleChange } from "../lib/audited-role-change";
import { accessAuditStore, accessHistoryPage } from "../lib/access-history";

const router: IRouter = Router();

router.get("/admin/access-history", async (req, res): Promise<void> => {
  const parsed = ListAccessHistoryQueryParams.safeParse(req.query);
  if (!parsed.success || !!parsed.data.beforeTime !== !!parsed.data.beforeId ||
      (parsed.data.beforeTime && !Number.isFinite(Date.parse(parsed.data.beforeTime)))) {
    res.status(400).json({ error: "Invalid history page." });
    return;
  }
  try {
    const { beforeTime, beforeId } = parsed.data;
    const cursor = beforeTime && beforeId ? { beforeTime: new Date(beforeTime).toISOString(), beforeId } : undefined;
    res.json(ListAccessHistoryResponse.parse(await accessHistoryPage(cursor)));
  } catch {
    req.log.warn("Unable to load access history");
    res.status(503).json({ error: "Access history could not be loaded. Try again shortly." });
  }
});

router.get("/admin/users", async (req, res) => {
  const query = ListAccessUsersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid account page." });
    return;
  }
  try {
    const { offset } = query.data;
    const page = await clerkClient.users.getUserList({ limit: 25, offset, orderBy: "-created_at" });
    res.json(ListAccessUsersResponse.parse({
      users: page.data.map(accessUser), total: page.totalCount, offset, limit: 25,
    }));
  } catch {
    req.log.warn("Unable to list accounts");
    res.status(503).json({ error: "Unable to load accounts. Try again shortly." });
  }
});

router.patch("/admin/users/:userId/role", async (req, res) => {
  const params = ChangeAccessRoleParams.safeParse(req.params);
  const body = ChangeAccessRoleBody.strict().safeParse(req.body);
  if (!params.success || !body.success) {
    try {
      await accessAuditStore.start({
        actorId: res.locals.access.userId,
        targetId: null, requestedRole: null, outcome: "denied", reason: "invalid_request",
      });
    } catch {
      res.status(503).json({ error: "Access history is unavailable. No change was attempted." });
      return;
    }
    res.status(400).json({ error: "Provide a valid account, role, and expected current role." });
    return;
  }
  try {
    const updated = await auditedRoleChange(accessAuditStore, withRoleLock,
      clerkClient.users, res.locals.access.userId, params.data.userId, body.data.role, body.data.expectedRole,
    );
    res.json(ChangeAccessRoleResponse.parse(updated));
  } catch (error) {
    if (error instanceof AccessConflict) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
      res.status(404).json({ error: "Account not found. Refresh the account list." });
      return;
    }
    req.log.warn("Unable to change account permissions");
    res.status(503).json({ error: "Unable to confirm the role change. Refresh the account list before retrying." });
  }
});

export default router;
