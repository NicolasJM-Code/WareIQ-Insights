/// <reference lib="dom" />
import { afterAll, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { cleanupFixture, createHostedFixture, preflight, recoverFixture } from "./fixture";

const databasePoolConstructor = vi.hoisted(() => vi.fn());
vi.mock("pg", () => {
  class BlockedPool {
    constructor() {
      databasePoolConstructor();
      throw new Error("Hosted browser checks must not construct a PostgreSQL pool");
    }
  }
  return { default: { Pool: BlockedPool }, Pool: BlockedPool };
});

// Same production middleware/guards as the cookie check; never open customer DBs.
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
  try { await browser?.close(); }
  finally {
    try { await cleanupFixture(); }
    finally {
      try { await vite?.close(); }
      finally {
        if (server) await new Promise<void>((done, reject) => server!.close(e => e ? reject(e) : done()));
      }
    }
  }
});

async function locked(page: Page) {
  await page.getByTestId("permissions").waitFor({ state: "visible" });
  expect(await page.getByTestId("report-gate").count()).toBe(0);
  expect(await page.getByTestId("admin-gate").count()).toBe(0);
  expect(await page.getByTestId("permissions").textContent()).toBe("locked");
  const before = reached;
  const statuses = await page.evaluate(async () => {
    const statuses = [];
    for (const path of ["/api/reports/hosted-integration", "/api/settings/access", "/api/access/own-reports"]) {
      statuses.push((await fetch(path, { credentials: "same-origin", cache: "no-store" })).status);
    }
    return statuses;
  });
  expect(statuses).toEqual([401, 401, 401]);
  expect(reached).toBe(before);
}

async function enterCredentials(page: Page, fixture: { email: string; password: string }) {
  // Real production <SignIn>, not signIn.create, tickets, token/cookie injection,
  // saved browser state, or the Clerk testing signIn helper.
  phase = "hosted email entry";
  await page.locator('input[name="identifier"]').fill(fixture.email);
  // Clerk supports both one-page and identifier-first password screens.
  if (!await page.locator('input[name="password"]').isVisible()) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  phase = "hosted password entry";
  await page.locator('input[name="password"]').fill(fixture.password);
}

it("opens reporting only after the hosted password screen and cookie handshake succeed", async () => {
  preflight("CLERK_HOSTED_TESTS");
  try {
    const recovery = process.env.CLERK_BROWSER_CLEANUP_MANIFEST;
    if (recovery) { await recoverFixture(recovery); return; }
    phase = "local isolated hosted-screen harness startup";
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLERK_BROWSER_EXECUTABLE || undefined });
    const app = (await import("../src/app")).default;
    const router = (await import("../src/routes")).default;
    router.get("/reports/hosted-integration", (_req, res) => { reached++; res.json({ permitted: true }); });
    vite = await createServer({
      configFile: false, root: resolve("artifacts/wareiq/browser-tests"),
      cacheDir: resolve(".cache/clerk-hosted-vite"),
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
    phase = "disposable Development password account creation";
    const fixture = await createHostedFixture();
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    phase = "hosted password screen load";
    await page.goto(`${origin}/sign-in`);
    await locked(page);
    phase = "hosted password submission";
    await enterCredentials(page, fixture);
    phase = "hosted password completion";
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // Clerk's supported Development test-email code; no mailbox or real email.
    // Some instances require client-trust email verification after a password.
    const code = page.locator('input[autocomplete="one-time-code"]').first();
    await Promise.race([
      page.getByTestId("admin-gate").waitFor({ state: "visible" }),
      code.waitFor({ state: "visible" }),
    ]);
    if (await code.isVisible()) {
      phase = "Development test-email verification";
      await code.fill("424242");
    }
    phase = "hosted sign-in reporting control";
    await page.getByTestId("admin-gate").waitFor({ state: "visible" });
    // Reload requires real browser cookies, not just a local signed-in React state.
    await page.reload();
    await page.getByTestId("admin-gate").waitFor({ state: "visible" });
    expect(await page.getByTestId("report-gate").count()).toBe(1);
    expect(await page.getByTestId("permissions").textContent()).toBe("allowed");
    const control = await page.evaluate(async () => {
      const report = await fetch("/api/reports/hosted-integration", { credentials: "same-origin", cache: "no-store" });
      const summary = await fetch("/api/access/me", { credentials: "same-origin", cache: "no-store" });
      const access = await summary.json();
      return { report: report.status, summary: summary.status,
        active: access.status === "active" && access.platformAdmin === true && access.reportIds.length > 0 };
    });
    expect(control).toEqual({ report: 200, summary: 200, active: true });
    expect((await context.cookies(origin)).some(c => c.name === "__session" && c.value.length > 0)).toBe(true);
    await context.close();

    phase = "failed hosted-screen load denial";
    const screenContext = await browser.newContext({ serviceWorkers: "block" });
    const screen = await screenContext.newPage();
    let blockedScreen = 0;
    await screenContext.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) {
        if (route.request().resourceType() === "script") blockedScreen++;
        return route.abort();
      }
      return route.continue();
    });
    await screen.goto(`${origin}/sign-in`);
    await expect.poll(() => blockedScreen).toBeGreaterThan(0);
    await screen.getByTestId("permissions").waitFor();
    await locked(screen);
    expect(await screen.locator('input[name="identifier"]').count()).toBe(0);
    await screen.goto(`${origin}/dashboard`);
    await locked(screen);
    await screenContext.close();

    phase = "failed sign-in handshake denial";
    const failedContext = await browser.newContext({ serviceWorkers: "block" });
    const failed = await failedContext.newPage();
    await failed.goto(`${origin}/sign-in`);
    await enterCredentials(failed, fixture);
    let blockedHandshake = 0;
    await failedContext.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin && url.pathname.includes("/client/sign_ins")) {
        blockedHandshake++;
        return route.abort();
      }
      return route.continue();
    });
    await failed.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => blockedHandshake).toBeGreaterThan(0);
    await locked(failed);
    await failed.reload();
    await failed.getByTestId("permissions").waitFor();
    await locked(failed);
    await failed.goto(`${origin}/dashboard`);
    await locked(failed);
    await failedContext.close();
    console.info("Hosted password control, screen-load denial, and sign-in handshake denial passed.");
  } catch {
    // Playwright/provider errors may embed generated passwords, cookies or URLs.
    throw new Error(`Clerk hosted-screen check failed during ${phase}; sensitive details suppressed. Retain any cleanup journal.`);
  }
});
