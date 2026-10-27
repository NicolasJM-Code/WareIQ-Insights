import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const fake = vi.hoisted(() => ({
  createUser: vi.fn(), getUser: vi.fn(), deleteUser: vi.fn(),
  writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), unlink: vi.fn(),
}));
vi.mock("@clerk/express", () => ({
  clerkClient: { users: { createUser: fake.createUser, getUser: fake.getUser, deleteUser: fake.deleteUser } },
}));
vi.mock("node:fs/promises", () => ({
  writeFile: fake.writeFile, mkdir: fake.mkdir, rename: fake.rename, unlink: fake.unlink,
  readFile: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("CLERK_HOSTED_TESTS", "");
  vi.stubEnv("CLERK_BROWSER_TESTS", "isolated-development-only");
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_synthetic");
  vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_synthetic");
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
  const entry = readFileSync("artifacts/api-server/browser-tests/hosted.test.ts", "utf8");
  expect(entry.indexOf('preflight("CLERK_HOSTED_TESTS")')).toBeLessThan(entry.indexOf('await import("../src/app")'));
  expect(entry).not.toContain("signInTokens.");
  expect(entry).not.toContain("setActive(");
});
