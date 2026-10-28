/// <reference lib="dom" />
import { afterAll, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { clerkClient } from "@clerk/express";
import { cleanupFixture, createFixture, preflight, recoverFixture, safe } from "./fixture";

const databasePoolConstructor = vi.hoisted(() => vi.fn());
vi.mock("pg", () => {
  class BlockedPool {
    constructor() {
      databasePoolConstructor();
      throw new Error("Browser checks must not construct a PostgreSQL pool");
    }
  }
  return { default: { Pool: BlockedPool }, Pool: BlockedPool };
});

// Real Clerk and production authorization; no WMS/application database opens.
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
}));
vi.mock("../src/lib/logger", () => ({
  logger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {}, level: "silent" }) },
}));
vi.mock("pino-http", () => ({
  default: () => (req: { log: unknown }, _res: unknown, next: () => void) => {
    req.log = { warn() {}, error() {} }; next();
  },
}));

let browser: Browser | undefined;
let vite: ViteDevServer | undefined;
let server: Server | undefined;
let origin: string;
let reached = 0;
let phase = "preflight";

it("keeps browser execution isolated from application and WMS databases", () => {
  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.WMS_DATABASE_URL).toBeUndefined();
  expect(process.env.WMS_PGPASSWORD).toBeUndefined();
  expect(databasePoolConstructor).not.toHaveBeenCalled();
});

afterAll(async () => {
  // Attempt provider cleanup even if local shutdown fails.
  try {
    await browser?.close();
  } finally {
    try {
      await cleanupFixture();
    } finally {
      await vite?.close();
      if (server) await new Promise<void>((done, reject) => server!.close(e => e ? reject(e) : done()));
    }
  }
});

// Only shape needed from Clerk's real browser global; credentials stay in memory.
type BrowserClerk = {
  loaded: boolean;
  session: { id: string; getToken: () => Promise<string | null> } | null;
  client: { signIn: { create: (p: { strategy: "ticket"; ticket: string }) => Promise<{ createdSessionId: string | null }> } };
  setActive: (p: { session: string }) => Promise<void>;
};
declare global { interface Window { Clerk: BrowserClerk } }

async function signIn(userId: string) {
  const context = await browser!.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  phase = "browser document load";
  await page.goto(origin);
  phase = "Clerk browser SDK load";
  await page.waitForFunction(() => window.Clerk?.loaded === true);
  // Before authentication neither guard may render its protected child.
  expect(await page.getByTestId("report-gate").count()).toBe(0);
  expect(await page.getByTestId("admin-gate").count()).toBe(0);
  phase = "browser ticket sign-in";
  const ticket = await clerkClient.signInTokens.createSignInToken({ userId, expiresInSeconds: 60 });
  await page.evaluate(async (token) => {
    const result = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket: token });
    if (!result.createdSessionId) throw new Error("No browser session");
    await window.Clerk.setActive({ session: result.createdSessionId });
  }, ticket.token);
  phase = "initial cookie-authenticated guard control";
  await page.getByTestId("admin-gate").waitFor({ state: "visible" });
  expect(await page.getByTestId("permissions").textContent()).toBe("allowed");
  // A reload proves real cookies authenticate, rather than React-only state.
  phase = "cookie-authenticated reload control";
  await page.reload();
  await page.getByTestId("admin-gate").waitFor({ state: "visible" });
  const identity = await page.evaluate(async () => {
    const jwt = await window.Clerk.session!.getToken();
    if (!jwt) throw new Error("No token");
    return { sessionId: window.Clerk.session!.id, exp: JSON.parse(atob(jwt.split(".")[1])).exp as number };
  });
  const cookies = await context.cookies(origin);
  expect(cookies.some(c => c.name === "__session" && c.value.length > 0)).toBe(true);
  // No Authorization header, no manually inserted cookies, no mocked access API.
  const control = await page.evaluate(async () => {
    const report = await fetch("/api/reports/browser-integration", { credentials: "same-origin", cache: "no-store" });
    const summary = await fetch("/api/access/me", { credentials: "same-origin", cache: "no-store" });
    const access = await summary.json();
    return { report: report.status, summary: summary.status,
      active: access.status === "active" && access.platformAdmin === true && access.reportIds.length > 0 };
  });
  expect(control).toEqual({ report: 200, summary: 200, active: true });
  return { context, page, ...identity };
}

async function freezeRefresh(context: BrowserContext) {
  // Keep the authentic cookie but stop Clerk refreshing it or learning about
  // revocation. The application's real /access/me polling must fail closed.
  let blockedRenewals = 0;
  const block = (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && /\/client\/sessions\/[^/]+\/tokens(?:\/|$)/.test(url.pathname)) blockedRenewals++;
    return url.origin === origin ? route.continue() : route.abort();
  };
  await context.route("**/*", block);
  return {
    blockedRenewals: () => blockedRenewals,
    restore: () => context.unroute("**/*", block),
  };
}

async function cookieControl(page: Page) {
  // Re-prove the cookie transport *after* refresh is blocked, immediately
  // before revocation. Otherwise SDK sign-out could make denial a false pass.
  expect(await page.getByTestId("report-gate").count()).toBe(1);
  expect(await page.getByTestId("admin-gate").count()).toBe(1);
  expect(await page.getByTestId("permissions").textContent()).toBe("allowed");
  const result = await page.evaluate(async () => {
    const report = await fetch("/api/reports/browser-integration", { credentials: "same-origin", cache: "no-store" });
    const summary = await fetch("/api/access/me", { credentials: "same-origin", cache: "no-store" });
    const access = await summary.json();
    return { report: report.status, summary: summary.status,
      active: access.status === "active" && access.platformAdmin === true && access.reportIds.length > 0 };
  });
  expect(result).toEqual({ report: 200, summary: 200, active: true });
}

function watchRevalidation(page: Page) {
  // A lost Clerk cookie may produce a 200 signed_out summary rather than a
  // 401. In either case the hook has to consume this fresh server response.
  return page.waitForResponse(response => new URL(response.url()).pathname === "/api/access/me",
    { timeout: 35_000 });
}

async function locked(page: Page, recheck: ReturnType<typeof watchRevalidation>, label: string) {
  // use-access.ts polls every 15s. access.tsx must stop granting permissions even
  // though React Query retains the last successful response on a refetch error.
  phase = `${label} access recheck`;
  await recheck;
  phase = `${label} permission lock`;
  await page.waitForFunction(() => document.querySelector('[data-testid="permissions"]')?.textContent === "locked",
    undefined, { timeout: 35_000 });
  expect(await page.getByTestId("report-gate").count()).toBe(0);
  expect(await page.getByTestId("admin-gate").count()).toBe(0);
  phase = `${label} protected API denial`;
  const before = reached;
  const result = await page.evaluate(async () => {
    const statuses = [];
    for (const path of ["/api/reports/browser-integration", "/api/settings/access", "/api/access/own-reports"]) {
      statuses.push((await fetch(path, { credentials: "same-origin", cache: "no-store" })).status);
    }
    const response = await fetch("/api/access/me", { credentials: "same-origin", cache: "no-store" });
    const summary = response.status === 200 ? await response.json() : null;
    return { statuses, denied: response.status === 401 || (response.status === 200
      && summary.status === "signed_out" && !summary.platformAdmin && summary.reportIds.length === 0) };
  });
  expect(result).toEqual({ statuses: [401, 401, 401], denied: true });
  expect(reached).toBe(before);
}

async function sessionCookie(context: BrowserContext) {
  // Observe only. Never ask getToken/skipCache to manufacture a renewal.
  const cookie = (await context.cookies(origin)).find(c => c.name === "__session");
  if (!cookie?.value) throw new Error("Missing session cookie");
  const claims = JSON.parse(Buffer.from(cookie.value.split(".")[1], "base64url").toString("utf8"));
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || typeof claims.sid !== "string")
    throw new Error("Invalid session cookie claims");
  return { exp: claims.exp as number, iat: claims.iat as number, sid: claims.sid as string };
}

async function pastExpiry(exp: number) {
  const wait = exp * 1000 - Date.now() + 6_000;
  if (!Number.isFinite(wait) || wait < 0 || wait > 130_000) throw new Error("Unexpected token lifetime");
  await new Promise(done => setTimeout(done, wait));
}

async function recoverRenewal(
  context: BrowserContext, page: Page, last: Awaited<ReturnType<typeof sessionCookie>>,
  restore: () => Promise<void>,
) {
  // Observe the whole recovery window, not just a final snapshot: cached
  // permissions must never unlock either guard before fresh server evidence.
  const recovery = await page.evaluateHandle(() => {
    let unlocked = false;
    let activeSummary = false;
    let release!: () => void;
    const delivered = new Promise<void>(done => { release = done; });
    const originalFetch = window.fetch;
    // Observe and delay the browser's real fetch result, not a request made
    // through Playwright's API client (which has different cookie handling).
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch.apply(window, args);
      if (new URL(response.url).pathname === "/api/access/me" && response.status === 200) {
        const access = await response.clone().json();
        if (access.status === "active" && access.platformAdmin === true && access.reportIds.length > 0) {
          activeSummary = true;
          await delivered;
        }
      }
      return response;
    };
    const check = () => {
      unlocked ||= document.querySelector('[data-testid="permissions"]')?.textContent !== "locked"
        || !!document.querySelector('[data-testid="report-gate"], [data-testid="admin-gate"]');
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return {
      received: () => activeSummary,
      release,
      stop: () => { check(); observer.disconnect(); return unlocked; },
      dispose: () => { release(); observer.disconnect(); window.fetch = originalFetch; },
    };
  });
  try {
    phase = "restored SDK networking and passive cookie recovery";
    await restore();
    await expect.poll(async () => {
      const fresh = await sessionCookie(context);
      return fresh.sid === last.sid && fresh.iat > last.iat && fresh.exp > last.exp
        && fresh.exp * 1000 > Date.now();
    }, { timeout: 90_000, interval: 500 }).toBe(true);

    phase = "fresh server authorization held before guard recovery";
    await expect.poll(() => recovery.evaluate(state => state.received()), { timeout: 35_000 }).toBe(true);
    // Even with a fresh SDK cookie and the server's successful response waiting
    // at the network boundary, the old cached summary must not grant access.
    phase = "cached permissions remain locked before fresh summary delivery";
    expect(await recovery.evaluate(state => state.stop())).toBe(false);
    expect(await page.getByTestId("permissions").textContent()).toBe("locked");
    expect(await page.getByTestId("report-gate").count()).toBe(0);
    expect(await page.getByTestId("admin-gate").count()).toBe(0);

    phase = "fresh access summary delivery and reporting recovery";
    await recovery.evaluate(state => state.release());
    await page.getByTestId("admin-gate").waitFor({ state: "visible" });
    await cookieControl(page);
  } finally {
    await recovery.evaluate(state => state.dispose());
    await recovery.dispose();
  }
}

async function renewal(userId: string) {
  phase = "renewal browser-authenticated positive control";
  const signedIn = await signIn(userId);
  const { context, page } = signedIn;
  try {
    const first = await sessionCookie(context);
    expect(first.sid).toBe(signedIn.sessionId);
    phase = "genuine SDK renewal beyond initial cookie expiry";
    // Keep this same document open and let Clerk's ordinary timer renew.
    // No reload, focus simulation, token injection or manual token refresh.
    await pastExpiry(first.exp);
    const renewed = await sessionCookie(context);
    expect(renewed.sid).toBe(first.sid);
    expect(renewed.iat).toBeGreaterThan(first.iat);
    expect(renewed.exp).toBeGreaterThan(first.exp);
    expect(renewed.exp * 1000).toBeGreaterThan(Date.now());
    phase = "post-renewal real access polling";
    const response = await watchRevalidation(page);
    expect(response.status()).toBe(200);
    const access = await response.json();
    expect(access.status === "active" && access.platformAdmin === true && access.reportIds.length > 0).toBe(true);
    await cookieControl(page);

    phase = "post-renewal blocked refresh positive control";
    const outage = await freezeRefresh(context);
    await cookieControl(page);
    // Snapshot after blocking: a renewal just before the block must not make
    // the denial assertion run against the wrong token's expiry.
    const last = await sessionCookie(context);
    expect(last.sid).toBe(first.sid);
    phase = "failed SDK renewal and natural cookie expiry";
    await pastExpiry(last.exp);
    const recheck = watchRevalidation(page);
    await locked(page, recheck, "failed renewal");
    expect(outage.blockedRenewals()).toBeGreaterThan(0);
    // Keep networking blocked for another complete access poll: stale cached
    // success must not unlock reporting while the outage continues.
    await locked(page, watchRevalidation(page), "continued renewal outage");
    await recoverRenewal(context, page, last, outage.restore);
    console.info("SDK renewal preserved reporting; outage locked guards; fresh cookies and server access restored reporting.");
  } finally {
    await context.close();
  }
}

const renewalRun = process.env.CLERK_BROWSER_SCENARIO === "renewal";
it(renewalRun
  ? "renews real browser cookies, locks on failed renewal, then safely recovers after connectivity returns"
  : "authenticates real browser cookies then locks reporting on expiry and immediate revocation", async () => {
  // Fail without network or account creation unless explicitly enabled.
  preflight();
  await safe(phase, async () => {
    const recovery = process.env.CLERK_BROWSER_CLEANUP_MANIFEST;
    if (recovery) { await recoverFixture(recovery); return; }
    phase = "local isolated harness startup";
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLERK_BROWSER_EXECUTABLE || undefined });
    const app = (await import("../src/app")).default;
    const router = (await import("../src/routes")).default;
    router.get("/reports/browser-integration", (_req, res) => { reached++; res.json({ permitted: true }); });
    vite = await createServer({
      configFile: false, root: resolve("artifacts/wareiq/browser-tests"),
      cacheDir: resolve(".cache/clerk-browser-vite"),
      plugins: [react()], logLevel: "silent",
      resolve: { alias: [
        { find: "@/lib/report-catalog", replacement: resolve("artifacts/wareiq/browser-tests/catalog.ts") },
        { find: "@", replacement: resolve("artifacts/wareiq/src") },
      ], dedupe: ["react", "react-dom"] },
      define: { "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(process.env.CLERK_PUBLISHABLE_KEY),
        "import.meta.env.VITE_CLERK_PROXY_URL": "undefined" },
      server: { middlewareMode: true, hmr: false, fs: { allow: [resolve(".")] } },
    });
    app.use(vite.middlewares);
    server = await new Promise<Server>(done => {
      const listener = app.listen(0, "127.0.0.1", () => done(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local listener");
    origin = `http://127.0.0.1:${address.port}`;
    phase = "disposable fixture creation";
    const userId = await createFixture();
    if (renewalRun) { await renewal(userId); return; }
    phase = "expiry browser-authenticated positive control";
    const expired = await signIn(userId);
    await freezeRefresh(expired.context);
    const wait = expired.exp * 1000 - Date.now() + 6_000;
    if (!Number.isFinite(wait) || wait < 0 || wait > 130_000) throw new Error("Unexpected token lifetime");
    phase = "natural expiry revalidation";
    await new Promise(done => setTimeout(done, wait));
    const expiryRecheck = watchRevalidation(expired.page);
    await locked(expired.page, expiryRecheck, "expiry");
    await expired.context.close();
    phase = "fresh browser-authenticated positive control";
    const revoked = await signIn(userId);
    await freezeRefresh(revoked.context);
    phase = "post-block cookie-authenticated revocation control";
    await cookieControl(revoked.page);
    expect(revoked.exp * 1000 - Date.now()).toBeGreaterThan(10_000);
    const revocationRechecks = watchRevalidation(revoked.page);
    phase = "immediate revocation revalidation";
    await clerkClient.sessions.revokeSession(revoked.sessionId);
    await locked(revoked.page, revocationRechecks, "revocation");
    // Must be a revocation test, not another expiry test.
    expect(revoked.exp * 1000 - Date.now()).toBeGreaterThan(5_000);
    await revoked.context.close();
    console.info("Browser cookie positive controls, natural expiry, and immediate revocation passed.");
  }).catch(() => { throw new Error(`Clerk browser check failed during ${phase}; sensitive details suppressed.`); });
});
