import { beforeEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createKeyPairAttestation } from "../provider-tests/harness";

const fake = vi.hoisted(() => ({
  createUser: vi.fn(), getUser: vi.fn(), deleteUser: vi.fn(),
  getUserList: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), readFile: vi.fn(),
  rename: vi.fn(), unlink: vi.fn(),
}));
vi.mock("@clerk/express", () => ({
  clerkClient: { users: {
    createUser: fake.createUser, getUser: fake.getUser, getUserList: fake.getUserList, deleteUser: fake.deleteUser,
  } },
}));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  writeFile: fake.writeFile, mkdir: fake.mkdir, readFile: fake.readFile, rename: fake.rename, unlink: fake.unlink,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("CLERK_HOSTED_TESTS", "");
  vi.stubEnv("CLERK_BROWSER_TESTS", "isolated-development-only");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_synthetic");
  vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_synthetic");
  vi.stubEnv("CLERK_PROVIDER_KEY_PAIR_ATTESTATION",
    createKeyPairAttestation("sk_test_synthetic", "pk_test_synthetic"));
  vi.stubEnv("NODE_ENV", "test");
  vi.spyOn(console, "info").mockImplementation(() => {});
});

it("requires the hosted opt-in even when ticket browser checks are enabled", async () => {
  const { preflight } = await import("../browser-tests/fixture");
  expect(() => preflight("CLERK_HOSTED_TESTS")).toThrow("explicit opt-in");
  expect(fake.createUser).not.toHaveBeenCalled();
});

it.each(["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "NODE_ENV"])(
  "refuses unsafe %s before account creation", async key => {
    vi.stubEnv("CLERK_HOSTED_TESTS", "isolated-development-only");
    vi.stubEnv(key, key === "NODE_ENV" ? "production" : "live-not-a-development-key");
    const { preflight } = await import("../browser-tests/fixture");
    expect(() => preflight("CLERK_HOSTED_TESTS")).toThrow();
    expect(fake.createUser).not.toHaveBeenCalled();
  },
);

it.each([
  ["changed secret key", "CLERK_SECRET_KEY", "sk_test_changed"],
  ["changed publishable key", "CLERK_PUBLISHABLE_KEY", "pk_test_changed"],
])("refuses a stale key-pair attestation after a %s before provider or journal work", async (_label, key, value) => {
  vi.stubEnv("CLERK_HOSTED_TESTS", "isolated-development-only");
  vi.stubEnv(key, value);
  const { preflight, createFixture, recoverFixture } = await import("../browser-tests/fixture");
  expect(() => preflight("CLERK_HOSTED_TESTS")).toThrow("local pairing attestation");
  await expect(createFixture()).rejects.toThrow("local pairing attestation");
  await expect(recoverFixture(".cache/clerk-browser/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json"))
    .rejects.toThrow("local pairing attestation");
  for (const call of [
    fake.createUser, fake.getUser, fake.getUserList, fake.deleteUser,
    fake.mkdir, fake.readFile, fake.writeFile, fake.rename, fake.unlink,
  ]) expect(call).not.toHaveBeenCalled();
});

it.each([
  ["missing", undefined],
  ["malformed", "not-a-fingerprint"],
])("refuses a %s browser attestation before provider or journal work", async (_label, attestation) => {
  vi.stubEnv("CLERK_HOSTED_TESTS", "isolated-development-only");
  vi.stubEnv("CLERK_PROVIDER_KEY_PAIR_ATTESTATION", attestation);
  const { preflight, createFixture } = await import("../browser-tests/fixture");
  expect(() => preflight("CLERK_HOSTED_TESTS")).toThrow("local pairing attestation");
  await expect(createFixture()).rejects.toThrow("local pairing attestation");
  for (const call of [
    fake.createUser, fake.getUser, fake.getUserList, fake.deleteUser,
    fake.mkdir, fake.readFile, fake.writeFile, fake.rename, fake.unlink,
  ]) expect(call).not.toHaveBeenCalled();
});

it("rechecks the key pair before deleting a fixture after configuration drift", async () => {
  fake.createUser.mockResolvedValue({ id: "user_generated" });
  const { createFixture, cleanupFixture } = await import("../browser-tests/fixture");
  await createFixture();
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_changed");
  await expect(cleanupFixture()).rejects.toThrow("local pairing attestation");
  expect(fake.getUser).not.toHaveBeenCalled();
  expect(fake.deleteUser).not.toHaveBeenCalled();
  expect(fake.unlink).not.toHaveBeenCalled();
});

it("creates only a generated test-email account and keeps its password out of journals", async () => {
  fake.createUser.mockImplementation(async params => ({
    id: "user_generated", emailAddresses: params.emailAddress.map((emailAddress: string) => ({ emailAddress })),
    privateMetadata: params.privateMetadata,
  }));
  const { createHostedFixture, cleanupFixture } = await import("../browser-tests/fixture");
  const fixture = await createHostedFixture();
  const params = fake.createUser.mock.calls[0][0];
  expect(fixture.email).toMatch(/^wareiq-browser-[a-f0-9-]+\+clerk_test@example\.com$/);
  expect(params.password).toBe(fixture.password);
  expect(params.skipPasswordRequirement).toBeUndefined();
  for (const [, content, options] of fake.writeFile.mock.calls) {
    expect(content).not.toContain(fixture.password);
    expect(options.mode).toBe(0o600);
  }
  fake.getUser.mockResolvedValue(await fake.createUser.mock.results[0].value);
  await cleanupFixture();
  expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith("user_generated");
  expect(fake.unlink).toHaveBeenCalledOnce();
});

it("will not create an account without a saved intent", async () => {
  fake.writeFile.mockRejectedValue(new Error("disk failure"));
  const { createHostedFixture } = await import("../browser-tests/fixture");
  await expect(createHostedFixture()).rejects.toThrow("no account was created");
  expect(fake.createUser).not.toHaveBeenCalled();
});

it("retains ambiguous creation intent without retrying or guessing cleanup", async () => {
  fake.createUser.mockRejectedValue(new Error("sensitive provider detail"));
  const { createHostedFixture, cleanupFixture } = await import("../browser-tests/fixture");
  await expect(createHostedFixture()).rejects.toThrow("outcome is unknown");
  await cleanupFixture();
  expect(fake.createUser).toHaveBeenCalledOnce();
  expect(fake.deleteUser).not.toHaveBeenCalled();
  expect(fake.unlink).not.toHaveBeenCalled();
});

it("still deletes the owned account when saving its returned ID fails", async () => {
  fake.createUser.mockImplementation(async params => ({
    id: "user_generated", emailAddresses: params.emailAddress.map((emailAddress: string) => ({ emailAddress })),
    privateMetadata: params.privateMetadata,
  }));
  fake.rename.mockRejectedValue(new Error("journal update failed"));
  const { createHostedFixture, cleanupFixture } = await import("../browser-tests/fixture");
  await expect(createHostedFixture()).rejects.toThrow("ID-scoped cleanup will be attempted");
  fake.getUser.mockResolvedValue(await fake.createUser.mock.results[0].value);
  await cleanupFixture();
  expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith("user_generated");
});

it("refuses deletion and retains the journal on an ownership mismatch", async () => {
  fake.createUser.mockResolvedValue({ id: "user_generated" });
  const { createHostedFixture, cleanupFixture } = await import("../browser-tests/fixture");
  await createHostedFixture();
  fake.getUser.mockResolvedValue({
    id: "user_generated", privateMetadata: { wareiqBrowserTest: "not-this-run" },
    emailAddresses: [{ emailAddress: "not-the-generated-email@example.com" }],
  });
  await expect(cleanupFixture()).rejects.toThrow("ownership mismatch");
  expect(fake.deleteUser).not.toHaveBeenCalled();
  expect(fake.unlink).not.toHaveBeenCalled();
});

it("recovers an intent only when one exact-email result has the private run marker", async () => {
  const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const email = `wareiq-browser-${runId}+clerk_test@example.com`;
  const account = {
    id: "user_generated",
    privateMetadata: { wareiqBrowserTest: runId },
    emailAddresses: [{ emailAddress: email }],
  };
  fake.readFile.mockResolvedValue(JSON.stringify({
    kind: "wareiq-browser", state: "intent", runId, email,
  }));
  fake.getUserList.mockResolvedValue({ totalCount: 1, data: [account] });
  fake.getUser.mockResolvedValue(account);
  const { recoverFixture } = await import("../browser-tests/fixture");

  await recoverFixture(`.cache/clerk-browser/${runId}.json`);

  expect(fake.getUserList).toHaveBeenCalledExactlyOnceWith({ emailAddress: [email], limit: 2 });
  expect(fake.getUser).toHaveBeenCalledExactlyOnceWith("user_generated");
  expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith("user_generated");
  expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(new RegExp(`${runId.replaceAll("-", "\\-")}\\.json$`)),
  );
});

it.each([
  ["zero matches", { totalCount: 0, data: [] }, false],
  ["multiple matches", { totalCount: 2, data: [{ id: "user_one" }, { id: "user_two" }] }, true],
  ["mismatched count", { totalCount: 1, data: [] }, true],
  ["wrong private marker", {
    totalCount: 1,
    data: [{
      id: "user_unrelated",
      privateMetadata: { wareiqBrowserTest: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" },
      emailAddresses: [{ emailAddress: "wareiq-browser-other@example.com" }],
    }],
  }, true],
  ["wrong email", {
    totalCount: 1,
    data: [{
      id: "user_unrelated",
      privateMetadata: { wareiqBrowserTest: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" },
      emailAddresses: [{ emailAddress: "different@example.com" }],
    }],
  }, true],
])("does not delete an unrelated account after %s during intent recovery", async (_label, result, refuses) => {
  const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const email = `wareiq-browser-${runId}@example.com`;
  fake.readFile.mockResolvedValue(JSON.stringify({
    kind: "wareiq-browser", state: "intent", runId, email,
  }));
  fake.getUserList.mockResolvedValue(result);
  fake.getUser.mockResolvedValue({
    id: "user_unrelated",
    privateMetadata: { wareiqBrowserTest: "not-this-run" },
    emailAddresses: [{ emailAddress: "unrelated@example.com" }],
  });
  const { recoverFixture } = await import("../browser-tests/fixture");

  const recovery = recoverFixture(`.cache/clerk-browser/${runId}.json`);
  if (refuses) await expect(recovery).rejects.toThrow();
  else await recovery;

  expect(fake.deleteUser).not.toHaveBeenCalled();
  if (refuses) expect(fake.unlink).not.toHaveBeenCalled();
  else expect(fake.unlink).toHaveBeenCalledOnce();
});

it("retains the intent journal when the exact-email provider lookup is unavailable", async () => {
  const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const email = `wareiq-browser-${runId}@example.com`;
  fake.readFile.mockResolvedValue(JSON.stringify({
    kind: "wareiq-browser", state: "intent", runId, email,
  }));
  fake.getUserList.mockRejectedValue(new Error("sensitive provider detail"));
  const { recoverFixture } = await import("../browser-tests/fixture");

  await expect(recoverFixture(`.cache/clerk-browser/${runId}.json`))
    .rejects.toThrow("sensitive details suppressed");

  expect(fake.deleteUser).not.toHaveBeenCalled();
  expect(fake.unlink).not.toHaveBeenCalled();
});

it("retains the ID journal when provider deletion fails during recovery", async () => {
  const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const email = `wareiq-browser-${runId}@example.com`;
  const account = {
    id: "user_generated",
    privateMetadata: { wareiqBrowserTest: runId },
    emailAddresses: [{ emailAddress: email }],
  };
  fake.readFile.mockResolvedValue(JSON.stringify({
    kind: "wareiq-browser", runId, email, userId: account.id,
  }));
  fake.getUser.mockResolvedValue(account);
  fake.deleteUser.mockRejectedValue(new Error("sensitive provider detail"));
  const { recoverFixture } = await import("../browser-tests/fixture");

  await expect(recoverFixture(`.cache/clerk-browser/${runId}.json`))
    .rejects.toThrow("sensitive details suppressed");

  expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith(account.id);
  expect(fake.unlink).not.toHaveBeenCalled();
});

it("retains the ID journal when removal fails after provider deletion", async () => {
  const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const email = `wareiq-browser-${runId}@example.com`;
  const account = {
    id: "user_generated",
    privateMetadata: { wareiqBrowserTest: runId },
    emailAddresses: [{ emailAddress: email }],
  };
  fake.readFile.mockResolvedValue(JSON.stringify({
    kind: "wareiq-browser", runId, email, userId: account.id,
  }));
  fake.getUser.mockResolvedValue(account);
  fake.unlink.mockRejectedValue(new Error("journal removal failed"));
  const { recoverFixture } = await import("../browser-tests/fixture");

  await expect(recoverFixture(`.cache/clerk-browser/${runId}.json`))
    .rejects.toThrow("journal removal failed");

  expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith(account.id);
  expect(fake.unlink).toHaveBeenCalledOnce();
});

it("keeps hosted checks separate from offline and ticket browser discovery", () => {
  const offline = readFileSync("vitest.config.ts", "utf8");
  expect(offline).not.toContain("browser-tests");
  const ticket = readFileSync("vitest.browser.config.ts", "utf8");
  expect(ticket).toContain('include: ["artifacts/api-server/browser-tests/clerk.test.ts"]');
  expect(ticket).not.toContain("hosted.test.ts");
  const hosted = readFileSync("vitest.hosted.config.ts", "utf8");
  expect(hosted).toContain("browser-tests/hosted.test.ts");
  expect(hosted).toContain("browser-tests/isolate-database-env.ts");
  const ticketEntry = readFileSync("artifacts/api-server/browser-tests/clerk.test.ts", "utf8");
  expect(ticketEntry.indexOf("preflight();")).toBeLessThan(ticketEntry.indexOf('await import("../src/app")'));
  const entry = readFileSync("artifacts/api-server/browser-tests/hosted.test.ts", "utf8");
  expect(entry.indexOf('preflight("CLERK_HOSTED_TESTS")')).toBeLessThan(entry.indexOf('await import("../src/app")'));
  expect(entry).toContain("databasePoolConstructor");
  expect(entry).toContain("keeps browser execution isolated from application and WMS databases");
  expect(entry).not.toContain("signInTokens.");
  expect(entry).not.toContain("setActive(");
});

it("selects the longer two-tab outage only through its dedicated live command", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  expect(scripts["test:auth:browser:renewal:multitab"])
    .toBe("vitest run --config vitest.browser-renewal-multitab.config.ts");
  for (const command of ["test:auth", "test:auth:typecheck", "test:auth:browser",
    "test:auth:browser:renewal", "test:auth:browser:renewal:repeat", "build"]) {
    expect(scripts[command]).not.toContain("multitab");
  }
  const config = readFileSync("vitest.browser-renewal-multitab.config.ts", "utf8");
  expect(config).toContain('import browser from "./vitest.browser.config"');
  expect(config).toContain("...browser.test");
  expect(config).toContain('env: { CLERK_BROWSER_SCENARIO: "renewal-multitab" }');
  expect(config).toContain("testTimeout: 420_000");
  const offline = readFileSync("vitest.config.ts", "utf8");
  expect(offline).not.toContain("browser-tests");
  expect(offline).not.toContain("multitab");
});

it("selects the late sign-out response race only through its dedicated live command", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  expect(scripts["test:auth:browser:late-access-signout"])
    .toBe("vitest run --config vitest.browser-late-access-signout.config.ts");
  for (const command of ["test:auth", "test:auth:typecheck", "test:auth:browser",
    "test:auth:browser:renewal", "test:auth:browser:renewal:repeat",
    "test:auth:browser:renewal:multitab", "test:auth:hosted", "build"]) {
    expect(scripts[command]).not.toContain("late-access-signout");
  }
  const config = readFileSync("vitest.browser-late-access-signout.config.ts", "utf8");
  expect(config).toContain('import browser from "./vitest.browser.config"');
  expect(config).toContain("...browser.test");
  expect(config).toContain('env: { CLERK_BROWSER_SCENARIO: "late-access-signout" }');
  const offline = readFileSync("vitest.config.ts", "utf8");
  expect(offline).not.toContain("browser-tests");
  expect(offline).not.toContain("late-access-signout");
});

it.each([
  ["ticket", "artifacts/api-server/browser-tests/clerk.test.ts"],
  ["hosted", "artifacts/api-server/browser-tests/hosted.test.ts"],
])("stops the %s runner on missing or stale attestations before startup", async (runner, entrypoint) => {
  const workspaceRoot = resolve(process.cwd());
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "wareiq-browser-entrypoint-"));
  const configPath = join(directory, "vitest.config.ts");
  const setupPath = join(directory, "setup.ts");
  const networkBlockerPath = join(directory, "block-network.cjs");
  const fakePlaywrightPath = join(directory, "fake-playwright.ts");
  const fakeVitePath = join(directory, "fake-vite.ts");
  const fakeReactPath = join(directory, "fake-react.ts");
  const fakeClerkPath = join(directory, "fake-clerk.ts");
  const blockedAppPath = join(directory, "blocked-app.ts");
  const sideEffectLog = join(directory, "side-effects.jsonl");
  const journalPath = join(workspaceRoot, ".cache/clerk-browser/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json");
  const browserOptIn = runner === "ticket"
    ? { CLERK_BROWSER_TESTS: "isolated-development-only" }
    : { CLERK_HOSTED_TESTS: "isolated-development-only" };

  try {
    writeFileSync(networkBlockerPath, networkBlockerModule);
    writeFileSync(fakePlaywrightPath, fakeModule("playwright.launch"));
    writeFileSync(fakeVitePath, fakeModule("vite.createServer"));
    writeFileSync(fakeReactPath, `
import { appendFileSync } from "node:fs";
export default () => {
  appendFileSync(process.env.WAREIQ_BROWSER_SIDE_EFFECT_LOG!, "react.plugin\\\\n");
  return {};
};
`);
    writeFileSync(fakeClerkPath, `
import { appendFileSync } from "node:fs";
function called(name: string) {
  appendFileSync(process.env.WAREIQ_BROWSER_SIDE_EFFECT_LOG!, name + "\\\\n");
  throw new Error("fake Clerk call");
}
export const clerkClient = {
  users: {
    createUser: () => called("clerk.users.createUser"),
    getUser: () => called("clerk.users.getUser"),
    getUserList: () => called("clerk.users.getUserList"),
    deleteUser: () => called("clerk.users.deleteUser"),
  },
  sessions: {
    revokeSession: () => called("clerk.sessions.revokeSession"),
  },
  signInTokens: {
    createSignInToken: () => called("clerk.signInTokens.createSignInToken"),
  },
};
`);
    writeFileSync(blockedAppPath, `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.WAREIQ_BROWSER_SIDE_EFFECT_LOG!, "app.import\\\\n");
throw new Error("FORBIDDEN_BROWSER_APP_IMPORT");
export default {};
`);
    writeFileSync(setupPath, `
import { appendFileSync } from "node:fs";
import { vi } from "vitest";
const record = (name: string) => appendFileSync(process.env.WAREIQ_BROWSER_SIDE_EFFECT_LOG!, name + "\\\\n");
vi.mock("node:fs/promises", () => ({
  mkdir: async (...args: unknown[]) => { record("journal.mkdir"); throw new Error("fake journal"); },
  readFile: async (...args: unknown[]) => { record("journal.readFile"); throw new Error("fake journal"); },
  writeFile: async (...args: unknown[]) => { record("journal.writeFile"); throw new Error("fake journal"); },
  rename: async (...args: unknown[]) => { record("journal.rename"); throw new Error("fake journal"); },
  unlink: async (...args: unknown[]) => { record("journal.unlink"); throw new Error("fake journal"); },
}));
`);
    writeFileSync(configPath, `
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [{
    name: "block-browser-app-imports",
    enforce: "pre",
    resolveId(source) {
      if (source.includes("../src/app") || source.includes("../src/routes")) return ${JSON.stringify(blockedAppPath)};
      return null;
    },
  }],
  resolve: { alias: [
    { find: "playwright", replacement: ${JSON.stringify(fakePlaywrightPath)} },
    { find: "vite", replacement: ${JSON.stringify(fakeVitePath)} },
    { find: "@vitejs/plugin-react", replacement: ${JSON.stringify(fakeReactPath)} },
    { find: "@clerk/express", replacement: ${JSON.stringify(fakeClerkPath)} },
  ] },
  test: {
    environment: "node",
    include: [${JSON.stringify(entrypoint)}],
    setupFiles: [${JSON.stringify(setupPath)}],
    fileParallelism: false,
  },
});
`);

    for (const attestation of ["missing", "stale"] as const) {
      const validPairSecret = "sk_test_synthetic_original";
      const currentSecret = attestation === "stale" ? "sk_test_synthetic_changed" : validPairSecret;
      const currentPublishable = "pk_test_synthetic";
      const result = spawnSync(process.execPath, [
        join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
        "run", "--config", configPath, "--root", workspaceRoot, "--reporter=verbose",
      ], {
        cwd: workspaceRoot,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
          NODE_OPTIONS: `--require=${networkBlockerPath}`,
          NODE_ENV: "test",
          CLERK_SECRET_KEY: currentSecret,
          CLERK_PUBLISHABLE_KEY: currentPublishable,
          CLERK_PROVIDER_KEY_PAIR_ATTESTATION: attestation === "missing"
            ? ""
            : createKeyPairAttestation(validPairSecret, currentPublishable),
          CLERK_BROWSER_CLEANUP_MANIFEST: journalPath,
          WAREIQ_BROWSER_SIDE_EFFECT_LOG: sideEffectLog,
          ...browserOptIn,
        },
        encoding: "utf8",
        timeout: 45_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("local pairing attestation");
      expect(output).not.toContain("FORBIDDEN_BROWSER_APP_IMPORT");
      expect(output).not.toContain("FORBIDDEN_OFFLINE_NETWORK");
      expect(existsSync(sideEffectLog), `${runner} ${attestation} attestation caused a startup side effect`)
        .toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

const networkBlockerModule = `
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const forbidden = () => { throw new Error("FORBIDDEN_OFFLINE_NETWORK"); };
const localOnly = (original) => function (...args) {
  const parameters = Array.isArray(args[0]) ? args[0] : args;
  const options = parameters[0];
  const host = typeof options === "object" && options !== null
    ? options.host ?? options.hostname
    : typeof parameters[1] === "string" ? parameters[1] : undefined;
  const port = typeof options === "object" && options !== null ? options.port
    : typeof options === "number" ? options : undefined;
  if (!["localhost", "127.0.0.1", "::1"].includes(host) || Number(port) === 1) return forbidden();
  return Reflect.apply(original, this, args);
};
net.connect = localOnly(net.connect);
net.createConnection = localOnly(net.createConnection);
net.Socket.prototype.connect = localOnly(net.Socket.prototype.connect);
tls.connect = forbidden;
http.request = localOnly(http.request);
http.get = localOnly(http.get);
https.request = forbidden;
https.get = forbidden;
globalThis.fetch = forbidden;
`;

function fakeModule(event: string) {
  return `
import { appendFileSync } from "node:fs";
const called = () => {
  appendFileSync(process.env.WAREIQ_BROWSER_SIDE_EFFECT_LOG!, ${JSON.stringify(event + "\\n")});
  throw new Error("fake browser startup");
};
export const chromium = { launch: called };
export const createServer = called;
`;
}
