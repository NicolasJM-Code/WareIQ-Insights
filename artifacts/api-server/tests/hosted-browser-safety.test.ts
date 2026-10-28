import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
vi.mock("node:fs/promises", () => ({
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

it("keeps hosted checks separate from offline and ticket browser discovery", () => {
  const offline = readFileSync("vitest.config.ts", "utf8");
  expect(offline).not.toContain("browser-tests");
  const ticket = readFileSync("vitest.browser.config.ts", "utf8");
  expect(ticket).toContain('include: ["artifacts/api-server/browser-tests/clerk.test.ts"]');
  expect(ticket).not.toContain("hosted.test.ts");
  const hosted = readFileSync("vitest.hosted.config.ts", "utf8");
  expect(hosted).toContain("browser-tests/hosted.test.ts");
  const ticketEntry = readFileSync("artifacts/api-server/browser-tests/clerk.test.ts", "utf8");
  expect(ticketEntry.indexOf("preflight();")).toBeLessThan(ticketEntry.indexOf('await import("../src/app")'));
  const entry = readFileSync("artifacts/api-server/browser-tests/hosted.test.ts", "utf8");
  expect(entry.indexOf('preflight("CLERK_HOSTED_TESTS")')).toBeLessThan(entry.indexOf('await import("../src/app")'));
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
