import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accessRouter from "./access";
import adminUsersRouter from "./admin-users";
import { requireActiveSession, requireIdentity, requireReporter, requireAdministrator } from "../middlewares/access";
import wmsRouter from "./wms";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireActiveSession);
// Each access operation authenticates and authorizes internally. Only /access/me
// intentionally returns a signed-out status. Keep legacy endpoints protected too.
router.use(accessRouter);
// Default-deny covers all future reporting endpoints, including exports.
router.use(requireIdentity);
router.use(["/settings", "/config", "/connection", "/admin"], requireAdministrator);
router.use(wmsRouter);
router.use(adminUsersRouter);
router.use(requireReporter);

export default router;
