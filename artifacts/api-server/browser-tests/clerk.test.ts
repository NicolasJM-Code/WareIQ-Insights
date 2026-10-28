/// <reference lib="dom" />
import { afterAll, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response, type Route } from "playwright";
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

async function holdRecovery(page: Page) {
  // Observe the whole recovery window, not just a final snapshot: cached
  // permissions must never unlock either guard before fresh server evidence.
  return page.evaluateHandle(() => {
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
      const permissions = document.querySelector('[data-testid="permissions"]');
      unlocked ||= permissions?.textContent?.trim() !== "locked"
        || permissions?.getAttribute("data-can-administer") !== "false"
        || permissions?.getAttribute("data-can-report") !== "false"
        || !!document.querySelector('[data-testid="report-gate"], [data-testid="admin-gate"]');
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    return {
      received: () => activeSummary,
      release,
      // Keep observing until this tab's own response is released.
      locked: () => { check(); return !unlocked; },
      allow: () => { check(); observer.disconnect(); release(); return !unlocked; },
      dispose: () => { release(); observer.disconnect(); window.fetch = originalFetch; },
    };
  });
}

async function recoverRenewal(
  context: BrowserContext, page: Page, last: Awaited<ReturnType<typeof sessionCookie>>,
  restore: () => Promise<void>, label: string,
) {
  const recovery = await holdRecovery(page);
  try {
    phase = `${label}: restored SDK networking and passive cookie recovery`;
    await restore();
    await expect.poll(async () => {
      const fresh = await sessionCookie(context);
      return fresh.sid === last.sid && fresh.iat > last.iat && fresh.exp > last.exp
        && fresh.exp * 1000 > Date.now();
    }, { timeout: 90_000, interval: 500 }).toBe(true);

    phase = `${label}: fresh server authorization held before guard recovery`;
    await expect.poll(() => recovery.evaluate(state => state.received()), { timeout: 35_000 }).toBe(true);
    // Even with a fresh SDK cookie and the server's successful response waiting
    // at the network boundary, the old cached summary must not grant access.
    phase = `${label}: cached permissions remain locked before fresh summary delivery`;
    expect(await recovery.evaluate(state => state.locked())).toBe(true);
    expect(await page.getByTestId("permissions").textContent()).toBe("locked");
    expect(await page.getByTestId("report-gate").count()).toBe(0);
    expect(await page.getByTestId("admin-gate").count()).toBe(0);

    phase = `${label}: fresh access summary delivery and reporting recovery`;
    expect(await recovery.evaluate(state => state.allow())).toBe(true);
    await page.getByTestId("admin-gate").waitFor({ state: "visible" });
    await cookieControl(page);
  } finally {
    await recovery.evaluate(state => state.dispose());
    await recovery.dispose();
  }
}

async function multiTabRenewal(userId: string) {
  phase = "two-tab browser-authenticated positive controls";
  const { context, page: first, sessionId } = await signIn(userId);
  try {
    // A second document, not a second login/context: cookies and the SDK session
    // are shared, but each document owns its production QueryClient and guards.
    const second = await context.newPage();
    await second.goto(origin);
    await second.getByTestId("admin-gate").waitFor({ state: "visible" });
    const pages = [first, second];
    for (const page of pages) {
      expect(await page.evaluate(() => window.Clerk.session?.id)).toBe(sessionId);
      await cookieControl(page);
    }
    let navigations = 0;
    for (const page of pages) {
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    }

    phase = "two-tab SDK outage and latest shared cookie snapshot";
    const outage = await freezeRefresh(context);
    for (const page of pages) await cookieControl(page);
    const last = await sessionCookie(context);
    expect(last.sid).toBe(sessionId);
    phase = "two-tab natural expiry with SDK networking blocked";
    await pastExpiry(last.exp);
    // Production QueryClient pauses interval refetches in hidden documents.
    // Switch tabs like a user, without synthesizing events or changing hooks.
    // Arm the response observer first: foregrounding may revalidate immediately.
    for (const [index, page] of pages.entries()) {
      const recheck = watchRevalidation(page);
      await page.bringToFront();
      await locked(page, recheck, `tab ${index + 1} expiry`);
    }
    expect(outage.blockedRenewals()).toBeGreaterThan(0);
    for (const [index, page] of pages.entries()) {
      const recheck = watchRevalidation(page);
      await page.bringToFront();
      await locked(page, recheck, `tab ${index + 1} continued outage`);
    }

    // Hold each browser's original successful response independently. Never
    // replace permissions, replay another tab's response, or use route.fetch().
    const holds: Awaited<ReturnType<typeof holdRecovery>>[] = [];
    try {
      for (const page of pages) holds.push(await holdRecovery(page));
      phase = "two-tab passive SDK recovery in the same session";
      await outage.restore();
      await expect.poll(async () => {
        const fresh = await sessionCookie(context);
        return fresh.sid === sessionId && fresh.iat > last.iat && fresh.exp > last.exp
          && fresh.exp * 1000 > Date.now();
      }, { timeout: 90_000, interval: 500 }).toBe(true);

      phase = "each tab receives its own fresh server authorization";
      for (const [index, hold] of holds.entries()) {
        await pages[index].bringToFront();
        await expect.poll(() => hold.evaluate(state => state.received()), { timeout: 35_000 }).toBe(true);
        expect(await hold.evaluate(state => state.locked())).toBe(true);
      }
      phase = "first tab authorized while second tab remains locked";
      // Foreground before release, while the first fetch is still in flight.
      // Its subsequent full interval poll then runs without another focus event.
      await first.bringToFront();
      expect(await holds[0].evaluate(state => state.allow())).toBe(true);
      await first.getByTestId("admin-gate").waitFor({ state: "visible" });
      await cookieControl(first);
      // Observe a complete subsequent poll in the authorized tab. The other
      // tab must stay locked throughout, despite the shared fresh SDK cookie
      // and the first tab's now-successful permission cache.
      const response = await watchRevalidation(first);
      expect(response.status()).toBe(200);
      const summary = await response.json();
      expect(summary.status === "active" && summary.platformAdmin === true && summary.reportIds.length > 0).toBe(true);
      expect(await holds[1].evaluate(state => state.locked())).toBe(true);
      expect(await second.getByTestId("permissions").textContent()).toBe("locked");
      expect(await second.getByTestId("report-gate").count()).toBe(0);
      expect(await second.getByTestId("admin-gate").count()).toBe(0);

      phase = "second tab restores only after its own authorization delivery";
      await second.bringToFront();
      expect(await holds[1].evaluate(state => state.allow())).toBe(true);
      await second.getByTestId("admin-gate").waitFor({ state: "visible" });
      for (const page of pages) {
        await cookieControl(page);
        expect(await page.evaluate(() => window.Clerk.session?.id)).toBe(sessionId);
      }
      expect(context.pages()).toHaveLength(2);
      expect(navigations).toBe(0);
      expect(databasePoolConstructor).not.toHaveBeenCalled();
      console.info("Both open tabs locked after expiry and recovered only after their own fresh server authorization.");
    } finally {
      for (const hold of holds) {
        try { await hold.evaluate(state => state.dispose()); }
        finally { await hold.dispose(); }
      }
    }
  } finally {
    await context.close();
  }
}

async function renewal(userId: string, cycles: 1 | 2) {
  phase = "renewal browser-authenticated positive control";
  const signedIn = await signIn(userId);
  const { context, page } = signedIn;
  try {
    // After the initial reload control, every cycle must use this document.
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
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

    let previousExpiry = first.exp;
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const label = `renewal outage cycle ${cycle}`;
      phase = `${label}: blocked refresh positive control`;
      const outage = await freezeRefresh(context);
      await cookieControl(page);
      // Snapshot after blocking, including on the repeated outage: use the
      // recovered cookie, not the token that expired during the first outage.
      const last = await sessionCookie(context);
      expect(last.sid).toBe(first.sid);
      expect(last.exp).toBeGreaterThan(previousExpiry);
      phase = `${label}: failed SDK renewal and natural cookie expiry`;
      await pastExpiry(last.exp);
      await locked(page, watchRevalidation(page), label);
      expect(outage.blockedRenewals()).toBeGreaterThan(0);
      // Another complete poll must not reuse the cached successful summary,
      // including the fresh permissions obtained after the previous recovery.
      await locked(page, watchRevalidation(page), `${label}: continued outage`);
      await recoverRenewal(context, page, last, outage.restore, label);
      previousExpiry = last.exp;
      expect(navigations).toBe(0);
      console.info(`SDK renewal outage cycle ${cycle} locked guards; advancing cookies and fresh server access restored reporting.`);
    }
  } finally {
    await context.close();
  }
}

async function revokedRenewal(userId: string) {
  phase = "revoked recovery browser-authenticated positive control";
  const { context, page, sessionId } = await signIn(userId);
  try {
    const outage = await freezeRefresh(context);
    phase = "revoked recovery post-block cookie control";
    await cookieControl(page);
    const last = await sessionCookie(context);
    expect(last.sid).toBe(sessionId);
    expect(last.exp * 1000 - Date.now()).toBeGreaterThan(10_000);
    const before = reached;
    const recheck = watchRevalidation(page);
    phase = "revoke disposable session during SDK outage";
    const revoked = await clerkClient.sessions.revokeSession(sessionId);
    expect(revoked.status).toBe("revoked");
    await locked(page, recheck, "revoked during SDK outage");
    // Prove revocation, rather than another natural-expiry denial.
    expect(last.exp * 1000 - Date.now()).toBeGreaterThan(5_000);

    const observation = await page.evaluateHandle(() => {
      let unlocked = false;
      let activeSummary = false;
      const originalFetch = window.fetch;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch.apply(window, args);
        if (new URL(response.url).pathname === "/api/access/me" && response.status === 200) {
          const summary = await response.clone().json();
          activeSummary ||= summary.status === "active" || summary.platformAdmin === true
            || (Array.isArray(summary.reportIds) && summary.reportIds.length > 0);
        }
        return response;
      };
      const check = () => {
        const permissions = document.querySelector('[data-testid="permissions"]');
        unlocked ||= permissions?.textContent?.trim() !== "locked"
          || permissions?.getAttribute("data-can-administer") !== "false"
          || permissions?.getAttribute("data-can-report") !== "false"
          || !!document.querySelector('[data-testid="report-gate"], [data-testid="admin-gate"]');
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      return {
        result: () => { check(); return { unlocked, activeSummary }; },
        dispose: () => { observer.disconnect(); window.fetch = originalFetch; },
      };
    });
    let sdkResponses = 0;
    const observeSdk = (response: Response) => {
      const url = new URL(response.url());
      if (url.origin !== origin && /\/client(?:\/|$)/.test(url.pathname)) sdkResponses++;
    };
    context.on("response", observeSdk);
    try {
      phase = "restore SDK networking for revoked session";
      await outage.restore();
      // A final locked snapshot alone could pass if networking never recovered.
      // Require a real Clerk client response, without logging its URL or body.
      await expect.poll(() => sdkResponses, { timeout: 90_000 }).toBeGreaterThan(0);
      phase = "revoked recovery beyond pre-outage cookie expiry";
      if (last.exp * 1000 + 6_000 > Date.now()) await pastExpiry(last.exp);
      await locked(page, watchRevalidation(page), "revoked after SDK recovery");
      await locked(page, watchRevalidation(page), "continued revoked recovery");
      phase = "revoked recovery continuous lock evidence";
      expect(await observation.evaluate(state => state.result())).toEqual({ unlocked: false, activeSummary: false });
      // SDK sign-out is allowed, but it must not silently select a new session.
      expect(await page.evaluate(id => window.Clerk.session === null || window.Clerk.session.id === id, sessionId)).toBe(true);
      expect((await clerkClient.sessions.getSession(sessionId)).status).toBe("revoked");
      expect(reached).toBe(before);
      expect(databasePoolConstructor).not.toHaveBeenCalled();
      console.info("Revoked session stayed locked after real SDK connectivity returned; protected APIs denied access.");
    } finally {
      context.off("response", observeSdk);
      await observation.evaluate(state => state.dispose());
      await observation.dispose();
    }
  } finally {
    await context.close();
  }
}

const repeatRun = process.env.CLERK_BROWSER_SCENARIO === "renewal-repeat";
const renewalRun = process.env.CLERK_BROWSER_SCENARIO === "renewal";
const multiTabRun = process.env.CLERK_BROWSER_SCENARIO === "renewal-multitab";
it(multiTabRun
  ? "requires independent fresh server authorization in two open tabs after an SDK outage"
  : repeatRun
  ? "recovers reporting through two SDK networking outages in the same document and session"
  : renewalRun
  ? "recovers valid browser sessions after renewal outages but keeps revoked sessions locked"
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
    if (multiTabRun) { await multiTabRenewal(userId); return; }
    if (repeatRun) { await renewal(userId, 2); return; }
    if (renewalRun) {
      await renewal(userId, 1);
      await revokedRenewal(userId);
      return;
    }
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
