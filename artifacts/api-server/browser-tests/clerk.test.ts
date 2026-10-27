/// <reference lib="dom" />
import { afterAll, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { clerkClient } from "@clerk/express";
import { cleanupFixture, createFixture, preflight, recoverFixture, safe } from "./fixture";

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
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
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

it("authenticates real browser cookies then locks reporting on expiry and immediate revocation", async () => {
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
