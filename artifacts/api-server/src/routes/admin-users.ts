import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import {
  ListAccessUsersQueryParams, ListAccessUsersResponse,
  ChangeAccessRoleParams, ChangeAccessRoleBody, ChangeAccessRoleResponse,
} from "@workspace/api-zod";
import { AccessConflict, accessUser, changeRole } from "../lib/role-management";
import { withRoleLock } from "../lib/role-lock";

const router: IRouter = Router();

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
    res.status(400).json({ error: "Provide a valid account, role, and expected current role." });
    return;
  }
  try {
    const updated = await withRoleLock(() => changeRole(
      clerkClient.users, res.locals.access.userId, params.data.userId, body.data.role, body.data.expectedRole,
    ));
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
