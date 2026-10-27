import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accessRouter from "./access";
import { requireIdentity, requireReporter, requireAdministrator } from "../middlewares/access";

const router: IRouter = Router();

router.use(healthRouter);
// Only the health endpoint (and the Clerk proxy mounted in app.ts) is public.
// Default-deny also covers future reporting endpoints, including exports.
router.use(requireIdentity);
router.use(["/settings", "/config", "/connection", "/admin"], requireAdministrator);
router.use(accessRouter);
router.use(requireReporter);

export default router;
