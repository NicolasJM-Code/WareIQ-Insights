import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import clerkEventsRouter from "./routes/clerk-events";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  forwardedOriginTrustMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

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
// X-Forwarded-Host/Proto are trusted only from explicitly configured ingress
// networks; direct callers cannot supply an alternate public origin.
app.use(forwardedOriginTrustMiddleware());
app.use("/api", clerkEventsRouter);
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
    const forwardedHost = req.get("x-forwarded-host");
    const forwardedProtocol = req.get("x-forwarded-proto");
    const hasDuplicateForwardedHeader = ["x-forwarded-host", "x-forwarded-proto"].some(
      (header) => req.rawHeaders.filter((value, index) =>
        index % 2 === 0 && value.toLowerCase() === header,
      ).length > 1,
    );
    const host = getClerkProxyHost(req);
    // The edge supplies the public host and protocol. Compare the complete
    // serialized origin: matching a hostname alone also permits HTTP/FTP origins.
    // The trusted edge may append internal hosts; validate the whole chain,
    // while retaining the documented leftmost public-host behavior.
    const protocolValues = forwardedProtocol?.split(",").map((value) => value.trim());
    const protocol = forwardedProtocol === undefined
      ? req.protocol
      : protocolValues?.length === 1 ? protocolValues[0] : undefined;
    let sameOrigin = false;
    try {
      const parsed = new URL(origin ?? "");
      const target = protocol && host ? new URL(`${protocol}://${host}`) : undefined;
      const forwardedHostChainIsValid = forwardedHost === undefined
        || forwardedHost.split(",").every((value) => {
          const candidate = value.trim();
          if (!candidate || candidate.includes("/") || candidate.includes("\\")
            || candidate.includes("?") || candidate.includes("#")) return false;
          const parsedHost = new URL(`https://${candidate}`);
          return !parsedHost.username && !parsedHost.password
            && parsedHost.pathname === "/" && !parsedHost.search && !parsedHost.hash;
        });
      sameOrigin = Boolean(!hasDuplicateForwardedHeader && forwardedHostChainIsValid && target
        && !target.username && !target.password
        && target.pathname === "/" && !target.search && !target.hash
        && (protocol === "http" || protocol === "https")
        && parsed.origin === origin && parsed.origin === target.origin);
    } catch { /* deny below */ }
    if (!sameOrigin || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "A same-origin request is required." });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "8kb" }));
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
