import { Router, type IRouter } from "express";
import { GetAuthSessionResponse, GetSettingsAccessResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/auth/session", (_req, res) => {
  res.json(GetAuthSessionResponse.parse(res.locals.access));
});

router.get("/settings/access", (_req, res) => {
  res.json(GetSettingsAccessResponse.parse({ canAdminister: true }));
});

export default router;
