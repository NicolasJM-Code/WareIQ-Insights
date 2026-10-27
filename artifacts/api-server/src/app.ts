import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.disable("x-powered-by");
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
// Browser clients are same-origin. Do not allow arbitrary sites to read APIs.
app.use(cors({ origin: false }));
app.use(clerkMiddleware((req) => ({
  publishableKey: publishableKeyFromHost(
    getClerkProxyHost(req) ?? "",
    process.env.CLERK_PUBLISHABLE_KEY,
  ),
})));
// Cookie-authenticated mutations must originate from this application.
app.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    const host = getClerkProxyHost(req);
    let originHost: string | undefined;
    try { originHost = origin ? new URL(origin).host : undefined; } catch { /* deny below */ }
    if (!originHost || originHost !== host || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "A same-origin request is required." });
      return;
    }
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});
app.use(((err, req, res, _next) => {
  req.log.warn({ status: err.status ?? 500 }, "Request failed");
  res.status(err.status === 400 ? 400 : 500).json({ error: "The request could not be completed." });
}) as express.ErrorRequestHandler);

export default app;
