import { Router, type IRouter } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { TestWmsConnectionBody, TestWmsConnectionResponse } from "@workspace/api-zod";
import { testConnection, testWmsVpn } from "../lib/wms-connection";
import { getWmsNetworkConfig } from "../lib/wms-openvpn";

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

router.get("/wms/connection/network", (_req, res) => {
  res.json(getWmsNetworkConfig());
});

router.post("/wms/connection/vpn-test", async (req, res): Promise<void> => {
  const parsed = TestWmsConnectionBody.strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the approved connection fields." }); return; }
  if (Date.now() < nextVpnAt) { res.status(429).json({ error: "Wait a few seconds before checking the VPN again." }); return; }
  nextVpnAt = Date.now() + 10000;
  res.json(await testWmsVpn(parsed.data));
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
    const result = TestWmsConnectionResponse.parse(await testConnection(parsed.data));
    req.log.info({ event: "wms_connection_test", status: result.status, code: result.code, userId: getAuth(req).userId }, "WMS connection test finished");
    res.json(result);
  } finally { busy = false; }
});

export default router;
