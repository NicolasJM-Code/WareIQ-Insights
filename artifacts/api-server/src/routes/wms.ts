import { Router, type IRouter, type Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { TestWmsConnectionBody, TestWmsConnectionResponse, GetWmsNetworkConfigResponse } from "@workspace/api-zod";
import { testConnection, testWmsVpn } from "../lib/wms-connection";
import { warehouseVpnHealth } from "../lib/wms-vpn-monitor";
import { getWmsNetworkConfig, mysqlConnectionPath } from "../lib/wms-openvpn";
import { AccessError, accessFor, requireMemberAccess } from "../lib/reporting-access";
import { WmsConnectionTestLimiter } from "../lib/wms-connection-test-limiter";
import { z } from "zod";

const router: IRouter = Router();
const connectionTestLimiter = new WmsConnectionTestLimiter();

function connectionTestSiteKey(scope: { siteId: string; clientId: string } | undefined): string {
  return scope ? JSON.stringify([scope.clientId, scope.siteId]) : "direct-connection";
}

function rejectLimitedTest(res: Response): void {
  res.setHeader("Retry-After", "10");
  res.status(429).json({ error: "Wait a few seconds before running another connection test." });
}

function rejectLimiterUnavailable(res: Response): void {
  res.status(503).json({ error: "Connection tests are temporarily unavailable. Try again shortly." });
}

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
    if (vpn && (req.method === "GET" || req.path.endsWith("/vpn-test") || req.body?.engine === "mysql")) {
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
  let release: (() => Promise<void>) | undefined;
  try {
    release = await connectionTestLimiter.acquire(connectionTestSiteKey(res.locals.wmsSiteScope), "vpn");
  } catch {
    rejectLimiterUnavailable(res);
    return;
  }
  if (!release) { rejectLimitedTest(res); return; }
  try {
    res.json(await testWmsVpn(parsed.data, res.locals.wmsSiteScope));
  } finally {
    await release().catch(() => {
      req.log.warn({ event: "wms_connection_test_limiter_release_failed" }, "Warehouse test slot release failed");
    });
  }
});

router.post("/wms/connection/test", async (req, res): Promise<void> => {
  const parsed = TestWmsConnectionBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the connection fields. Only verified TLS is supported; never send a password in this request." }); return;
  }
  let release: (() => Promise<void>) | undefined;
  try {
    release = await connectionTestLimiter.acquire(connectionTestSiteKey(res.locals.wmsSiteScope), "connection");
  } catch {
    rejectLimiterUnavailable(res);
    return;
  }
  if (!release) { rejectLimitedTest(res); return; }
  try {
    const result = TestWmsConnectionResponse.parse(await testConnection(parsed.data, { siteScope: res.locals.wmsSiteScope }));
    req.log.info({ event: "wms_connection_test", status: result.status, code: result.code, userId: getAuth(req).userId }, "WMS connection test finished");
    res.json(result);
  } finally {
    await release().catch(() => {
      req.log.warn({ event: "wms_connection_test_limiter_release_failed" }, "Warehouse test slot release failed");
    });
  }
});

export default router;
