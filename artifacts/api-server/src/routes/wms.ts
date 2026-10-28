import { Router, type IRouter } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { TestWmsConnectionBody, TestWmsConnectionResponse, GetWmsNetworkConfigResponse } from "@workspace/api-zod";
import { testConnection, testWmsVpn } from "../lib/wms-connection";
import { warehouseVpnHealth } from "../lib/wms-vpn-monitor";
import { getWmsNetworkConfig, mysqlConnectionPath } from "../lib/wms-openvpn";
import { AccessError, accessFor, requireMemberAccess } from "../lib/reporting-access";
import { z } from "zod";

const router: IRouter = Router();
let busy = false;
let nextTestAt = 0;
let nextVpnAt = 0;

router.use("/wms/connection", async (req, res, next): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const { userId } = getAuth(req);
  if (!userId) { res.status(401).json({ error: "Sign in to test the database connection." }); return; }
  try {
    // Read trusted server-side metadata, never a role supplied by the browser.
    const user = await clerkClient.users.getUser(userId);
    if (user.publicMetadata.role !== "admin") {
      res.status(403).json({ error: "Administrator access is required to test database connections." }); return;
    }
  } catch {
    res.status(503).json({ error: "Administrator access could not be verified. Try again shortly." }); return;
  }
  next();
});

router.use("/wms/connection", async (req, res, next): Promise<void> => {
  try {
    const vpn = mysqlConnectionPath() === "openvpn";
    if (vpn && (req.method === "GET" || req.path === "/vpn-test" || req.body?.engine === "mysql")) {
      const site = z.string().uuid().safeParse(req.method === "GET" ? req.query.siteId : req.body?.siteId);
      if (!site.success) { res.status(400).json({ error: "Select an assigned warehouse." }); return; }
      // Fresh membership, active client, role and assigned active sites for every request.
      const access = await accessFor(req);
      requireMemberAccess(access);
      if (!access.actor.platformAdmin || !access.session.sites.some((candidate) => candidate.id === site.data))
        throw new AccessError(403, "This warehouse is not assigned to you.");
      res.locals.wmsSiteScope = { siteId: site.data, clientId: access.client!.id };
    }
    next();
  } catch (error) {
    res.status(error instanceof AccessError ? error.status : 503)
      .json({ error: error instanceof AccessError ? error.message : "Warehouse access could not be verified." });
  }
});

router.get("/wms/connection/network", async (_req, res) => {
  const scope = res.locals.wmsSiteScope;
  res.json(GetWmsNetworkConfigResponse.parse({
    ...getWmsNetworkConfig(scope), monitoring: await warehouseVpnHealth(scope),
  }));
});

router.post("/wms/connection/vpn-test", async (req, res): Promise<void> => {
  const parsed = TestWmsConnectionBody.strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the approved connection fields." }); return; }
  if (Date.now() < nextVpnAt) { res.status(429).json({ error: "Wait a few seconds before checking the VPN again." }); return; }
  nextVpnAt = Date.now() + 10000;
  res.json(await testWmsVpn(parsed.data, res.locals.wmsSiteScope));
});

router.post("/wms/connection/test", async (req, res): Promise<void> => {
  const parsed = TestWmsConnectionBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the connection fields. Only verified TLS is supported; never send a password in this request." }); return;
  }
  if (busy || Date.now() < nextTestAt) {
    res.setHeader("Retry-After", "10");
    res.status(429).json({ error: "Wait a few seconds before running another connection test." }); return;
  }
  busy = true;
  nextTestAt = Date.now() + 10000;
  try {
    const result = TestWmsConnectionResponse.parse(await testConnection(parsed.data, { siteScope: res.locals.wmsSiteScope }));
    req.log.info({ event: "wms_connection_test", status: result.status, code: result.code, userId: getAuth(req).userId }, "WMS connection test finished");
    res.json(result);
  } finally { busy = false; }
});

export default router;
