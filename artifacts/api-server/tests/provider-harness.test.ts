import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journalIO, runProviderCheck, type Manifest, type ProviderUsers,
} from "../provider-tests/harness";

// No Clerk/app import. Synthetic strings only; never read process.env.
const safeEnv = {
  NODE_ENV: "test",
  CLERK_PROVIDER_TESTS: "isolated-development-only",
  CLERK_SECRET_KEY: "sk_test_offline_fake",
  CLERK_PUBLISHABLE_KEY: "pk_test_offline_fake",
};
const providerDetail = "FAKE_PRIVATE_PROVIDER_RESPONSE";
const outage = () => new Error(providerDetail);
const saved: Manifest = {
  userId: "user_offline_fixture",
  runId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  email: "wareiq-provider-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa@example.com",
};
function account(manifest: Manifest) {
  return {
    id: manifest.userId,
    privateMetadata: { wareiqProviderTest: manifest.runId },
    emailAddresses: [{ emailAddress: manifest.email }],
  };
}

describe("offline provider harness safety", () => {
  let directory: string;
  let user: ReturnType<typeof account>;
  let users: {
    createUser: ReturnType<typeof vi.fn<ProviderUsers["createUser"]>>;
    getUser: ReturnType<typeof vi.fn<ProviderUsers["getUser"]>>;
    getUserList: ReturnType<typeof vi.fn<ProviderUsers["getUserList"]>>;
    deleteUser: ReturnType<typeof vi.fn<ProviderUsers["deleteUser"]>>;
  };
  const check = vi.fn<(manifest: Manifest) => Promise<void>>();
  const info = vi.fn();
  const dependencies = () => ({ users, journalDirectory: directory, info });
  const recoveryEnv = () => ({
    ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: join(directory, "recovery.json"),
  });
  async function seed(text = JSON.stringify(saved)) {
    const env = recoveryEnv();
    await writeFile(env.CLERK_PROVIDER_CLEANUP_MANIFEST, text, { mode: 0o600 });
    return env;
  }
  async function retained(path: string, manifest = saved) {
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest);
  }
  async function failure(action: Promise<unknown>) {
    const error = await action.then(() => { throw new Error("Expected failure"); }, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(providerDetail);
    return String(error);
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "wareiq-provider-offline-"));
    user = account(saved);
    users = {
      createUser: vi.fn(async (params) => {
        user = {
          id: saved.userId,
          privateMetadata: params.privateMetadata,
          emailAddresses: params.emailAddress.map((emailAddress) => ({ emailAddress })),
        };
        return user;
      }),
      getUser: vi.fn(async () => user),
      getUserList: vi.fn(async ({ emailAddress }) => ({
        data: emailAddress.includes(user.emailAddresses[0]?.emailAddress) ? [user] : [],
        totalCount: emailAddress.includes(user.emailAddresses[0]?.emailAddress) ? 1 : 0,
      })),
      deleteUser: vi.fn(async () => undefined),
    };
    check.mockReset().mockResolvedValue(undefined);
    info.mockReset();
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each([
    ["missing opt-in", { CLERK_PROVIDER_TESTS: undefined }],
    ["wrong opt-in", { CLERK_PROVIDER_TESTS: "true" }],
    ["production mode", { NODE_ENV: "production" }],
    ["live secret", { CLERK_SECRET_KEY: "sk_live_offline_fake" }],
    ["live public key", { CLERK_PUBLISHABLE_KEY: "pk_live_offline_fake" }],
    ["missing secret", { CLERK_SECRET_KEY: undefined }],
    ["missing public key", { CLERK_PUBLISHABLE_KEY: undefined }],
  ])("refuses %s before provider, journal or application work", async (_name, override) => {
    // Recovery must not bypass preflight either.
    for (const recovery of [false, true]) {
      const journal = {
        mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(),
      };
      await expect(runProviderCheck(
        { ...(recovery ? recoveryEnv() : safeEnv), ...override },
        { ...dependencies(), journal: journal as unknown as typeof journalIO }, check,
      )).rejects.toThrow("explicit opt-in and development-only");
      for (const call of [...Object.values(users), ...Object.values(journal), check, info]) {
        expect(call).not.toHaveBeenCalled();
      }
    }
  });

  it("creates only a generated fixture, persists a private journal, and deletes after success", async () => {
    users.createUser.mockImplementation(async (params) => {
      const intentPath = join(directory, `${params.privateMetadata.wareiqProviderTest}.json`);
      const intent = JSON.parse(await readFile(intentPath, "utf8"));
      expect(intent).toEqual({
        state: "intent",
        runId: params.privateMetadata.wareiqProviderTest,
        email: params.emailAddress[0],
      });
      expect((await stat(intentPath)).mode & 0o777).toBe(0o600);
      user = {
        id: saved.userId,
        privateMetadata: params.privateMetadata,
        emailAddresses: params.emailAddress.map((emailAddress) => ({ emailAddress })),
      };
      return user;
    });
    check.mockImplementation(async (manifest) => {
      expect(manifest.email).toBe(`wareiq-provider-${manifest.runId}@example.com`);
      expect(manifest.runId).toMatch(/^[a-f0-9-]{36}$/);
      const path = join(directory, `${manifest.runId}.json`);
      await retained(path, manifest);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort())
        .toEqual(["email", "runId", "userId"]);
      expect(users.deleteUser).not.toHaveBeenCalled();
    });
    await runProviderCheck(safeEnv, dependencies(), check);
    expect(users.createUser).toHaveBeenCalledExactlyOnceWith({
      emailAddress: [user.emailAddresses[0].emailAddress],
      skipPasswordRequirement: true,
      publicMetadata: { role: "admin" },
      privateMetadata: user.privateMetadata,
    });
    expect(check).toHaveBeenCalledOnce();
    expect(users.getUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["assertion", "application setup"])("cleans up after %s fails", async (stage) => {
    const error = new Error(`${stage} failed`);
    check.mockImplementation(async () => {
      if (stage === "assertion") expect(false).toBe(true);
      throw error; // Models a failing dynamic app import/setup.
    });
    await expect(runProviderCheck(safeEnv, dependencies(), check)).rejects.toThrow();
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["private marker", "missing marker", "email", "multiple emails", "missing email", "returned ID"])(
    "refuses deletion for a mismatched %s and retains the recovery journal", async (field) => {
      const env = await seed();
      if (field === "private marker") user.privateMetadata.wareiqProviderTest = "another-run";
      if (field === "missing marker") user.privateMetadata = {} as typeof user.privateMetadata;
      if (field === "email") user.emailAddresses[0].emailAddress = "someone-else@example.com";
      if (field === "multiple emails") user.emailAddresses.push({ emailAddress: "other@example.com" });
      if (field === "missing email") user.emailAddresses = [];
      if (field === "returned ID") user.id = "user_not_requested";
      const message = await failure(runProviderCheck(env, dependencies(), check));
      expect(message).toContain("ownership check refused");
      expect(message).toContain("do not alter the journal or delete the account");
      expect(users.deleteUser).not.toHaveBeenCalled();
      expect(users.createUser).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    },
  );

  it.each(["invalid JSON", "null", "missing fields", "non-generated email", "wrong email run", "wrong user type"])(
    "rejects %s in recovery before provider calls", async (kind) => {
      const texts: Record<string, string> = {
        "invalid JSON": "{", null: "null", "missing fields": "{}",
        "non-generated email": JSON.stringify({ ...saved, email: "customer@example.com" }),
        "wrong email run": JSON.stringify({ ...saved, runId: "bbbbbbbb" }),
        "wrong user type": JSON.stringify({ ...saved, userId: 1 }),
      };
      const env = await seed(texts[kind]);
      const message = await failure(runProviderCheck(env, dependencies(), check));
      expect(message).toContain("no provider calls made");
      expect(await readFile(env.CLERK_PROVIDER_CLEANUP_MANIFEST, "utf8")).toBe(texts[kind]);
      for (const call of [...Object.values(users), check]) expect(call).not.toHaveBeenCalled();
    },
  );

  it("never creates an account or runs checks when the recovery file is missing", async () => {
    await expect(runProviderCheck(recoveryEnv(), dependencies(), check))
      .rejects.toThrow("unreadable or invalid");
    for (const call of [...Object.values(users), check]) expect(call).not.toHaveBeenCalled();
  });

  it("recovery deletes only the journaled fixture without creating accounts or running checks", async () => {
    const env = await seed();
    await runProviderCheck(env, dependencies(), check);
    expect(users.getUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("serializes recovery attempts and retains the journal for a safe retry", async () => {
    const env = await seed();
    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    users.getUser.mockImplementationOnce(async () => {
      signalLookupStarted();
      await lookupGate;
      return user;
    });
    users.deleteUser.mockRejectedValueOnce(outage());

    const firstAttempt = runProviderCheck(env, dependencies(), check);
    await lookupStarted;

    const secondAttemptError = await failure(runProviderCheck(env, dependencies(), check));
    expect(secondAttemptError).toContain("Recovery already in progress");
    expect(secondAttemptError).toContain("no provider calls made");
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    expect(users.getUser).toHaveBeenCalledOnce();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();

    releaseLookup();
    const firstAttemptError = await failure(firstAttempt);
    expect(firstAttemptError).toContain("Cleanup failed or ownership check refused deletion");
    expect(users.getUser).toHaveBeenCalledOnce();
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);

    await runProviderCheck(env, dependencies(), check);
    expect(users.getUser).toHaveBeenCalledTimes(2);
    expect(users.deleteUser).toHaveBeenCalledTimes(2);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("recovers an interrupted creation by exact email and marker without creating an account", async () => {
    const path = join(directory, "interrupted.json");
    const intent = { state: "intent", runId: saved.runId, email: saved.email };
    await writeFile(path, JSON.stringify(intent), { mode: 0o600 });
    const env = { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path };
    await runProviderCheck(env, dependencies(), check);
    expect(users.getUserList).toHaveBeenCalledExactlyOnceWith({
      emailAddress: [saved.email],
      limit: 2,
    });
    expect(users.getUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves and explicitly recovers the intent after an ambiguous create response", async () => {
    users.createUser.mockImplementationOnce(async (params) => {
      user = {
        id: saved.userId,
        privateMetadata: params.privateMetadata,
        emailAddresses: params.emailAddress.map((emailAddress) => ({ emailAddress })),
      };
      throw outage();
    });
    const message = await failure(runProviderCheck(safeEnv, dependencies(), check));
    expect(message).toContain("outcome is unknown");
    expect(message).toContain("CLERK_PROVIDER_CLEANUP_MANIFEST=");
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    const [filename] = await readdir(directory);
    const path = join(directory, filename);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      state: "intent",
      runId: users.createUser.mock.calls[0][0].privateMetadata.wareiqProviderTest,
      email: users.createUser.mock.calls[0][0].emailAddress[0],
    });

    await runProviderCheck({ ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path }, dependencies(), check);
    expect(users.createUser).toHaveBeenCalledOnce();
    expect(users.getUserList).toHaveBeenCalledExactlyOnceWith({
      emailAddress: [users.createUser.mock.calls[0][0].emailAddress[0]],
      limit: 2,
    });
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("recovers when the ID journal replacement fails and ID-scoped cleanup is interrupted", async () => {
    const failingJournal = {
      ...journalIO,
      rename: vi.fn<typeof journalIO.rename>().mockRejectedValue(outage()),
    };
    users.getUser.mockRejectedValueOnce(outage());
    const message = await failure(runProviderCheck(
      safeEnv,
      { ...dependencies(), journal: failingJournal, journalDirectory: directory },
      check,
    ));
    expect(message).toContain("Cleanup failed or ownership check refused deletion");
    const runId = users.createUser.mock.calls[0][0].privateMetadata.wareiqProviderTest;
    const journalPath = join(directory, `${runId}.json`);
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual({
      state: "intent",
      runId,
      email: users.createUser.mock.calls[0][0].emailAddress[0],
    });
    await runProviderCheck(
      { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: journalPath },
      dependencies(),
      check,
    );
    expect(users.createUser).toHaveBeenCalledOnce();
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes only an absent intent after an exact recovery lookup returns no account", async () => {
    const path = join(directory, "absent-intent.json");
    await writeFile(path, JSON.stringify({ state: "intent", runId: saved.runId, email: saved.email }), { mode: 0o600 });
    users.getUserList.mockResolvedValueOnce({ data: [], totalCount: 0 });
    await runProviderCheck({ ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path }, dependencies(), check);
    expect(users.getUserList).toHaveBeenCalledExactlyOnceWith({ emailAddress: [saved.email], limit: 2 });
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains an intent when exact-email recovery cannot reach the provider", async () => {
    const path = join(directory, "lookup-outage-intent.json");
    await writeFile(path, JSON.stringify({ state: "intent", runId: saved.runId, email: saved.email }), { mode: 0o600 });
    users.getUserList.mockRejectedValueOnce(outage());
    const env = { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path };
    const message = await failure(runProviderCheck(env, dependencies(), check));
    expect(message).toContain("Recovery lookup failed");
    expect(await readFile(path, "utf8")).toContain('"state":"intent"');
    expect(users.createUser).not.toHaveBeenCalled();
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();

    await runProviderCheck(env, dependencies(), check);
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains an intent when the exact-email recovery response is incomplete", async () => {
    const path = join(directory, "incomplete-result-intent.json");
    const intent = { state: "intent", runId: saved.runId, email: saved.email };
    await writeFile(path, JSON.stringify(intent), { mode: 0o600 });
    users.getUserList.mockResolvedValueOnce({ data: [user], totalCount: undefined } as never);
    const message = await failure(runProviderCheck(
      { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path }, dependencies(), check,
    ));
    expect(message).toContain("invalid exact-email result");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(intent);
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it.each(["wrong marker", "multiple matches"])("retains intent if recovery finds %s", async (issue) => {
    const path = join(directory, "unverified-intent.json");
    const intent = { state: "intent", runId: saved.runId, email: saved.email };
    await writeFile(path, JSON.stringify(intent), { mode: 0o600 });
    if (issue === "wrong marker") user.privateMetadata.wareiqProviderTest = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    else users.getUserList.mockResolvedValueOnce({ data: [user, user], totalCount: 2 });
    const message = await failure(runProviderCheck(
      { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path }, dependencies(), check,
    ));
    expect(message).toContain("Recovery refused");
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(intent);
  });

  it.each(["ownership lookup", "deletion"])("retains recovery evidence on provider %s outage, then recovers", async (stage) => {
    const env = await seed();
    const call = stage === "ownership lookup" ? users.getUser : users.deleteUser;
    call.mockRejectedValueOnce(outage());
    const message = await failure(runProviderCheck(env, dependencies(), check));
    expect(message).toContain(`CLERK_PROVIDER_CLEANUP_MANIFEST=${JSON.stringify(env.CLERK_PROVIDER_CLEANUP_MANIFEST)}`);
    expect(message).toContain("same Development instance");
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    if (stage === "ownership lookup") expect(users.deleteUser).not.toHaveBeenCalled();
    await runProviderCheck(env, dependencies(), check); // Follow the printed recovery instructions.
    expect(await readdir(directory)).toEqual([]);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("cleans up after a failed journal update without running application checks", async () => {
    let writes = 0;
    const journal = {
      ...journalIO,
      writeFile: vi.fn<typeof journalIO.writeFile>().mockImplementation(async (...args) => {
        writes++;
        if (writes === 1) return journalIO.writeFile(...args);
        throw outage();
      }),
    };
    const message = await failure(runProviderCheck(safeEnv, { ...dependencies(), journal }, check));
    expect(message).toContain("journal update failed");
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(check).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes a partially written journal update after safely deleting the fixture", async () => {
    let writes = 0;
    const journal = {
      ...journalIO,
      writeFile: vi.fn<typeof journalIO.writeFile>().mockImplementation(async (path, content, options) => {
        writes++;
        if (writes === 1) return journalIO.writeFile(path, content, options);
        await writeFile(path, "{partial", { mode: 0o600, flag: "wx" });
        throw outage();
      }),
    };
    await expect(runProviderCheck(safeEnv, { ...dependencies(), journal }, check))
      .rejects.toThrow("journal update failed");
    expect(users.deleteUser).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["lookup", "deletion"])("retains intent recovery instructions if journal update and cleanup %s fail", async (stage) => {
    let writes = 0;
    const journal = {
      ...journalIO,
      writeFile: vi.fn<typeof journalIO.writeFile>().mockImplementation(async (...args) => {
        writes++;
        if (writes === 1) return journalIO.writeFile(...args);
        throw outage();
      }),
    };
    if (stage === "lookup") users.getUser.mockRejectedValue(outage());
    else users.deleteUser.mockRejectedValue(outage());
    const message = await failure(runProviderCheck(safeEnv, { ...dependencies(), journal }, check));
    expect(message).toContain("Retain ");
    expect(message).toContain("CLERK_PROVIDER_CLEANUP_MANIFEST=");
    expect(message).toContain("same Development instance");
    expect(users.deleteUser).toHaveBeenCalledTimes(stage === "lookup" ? 0 : 1);
    expect(check).not.toHaveBeenCalled();
  });

  it.each(["normal run", "recovery"])("reports deletion accurately when journal unlink fails in %s", async (mode) => {
    const env = mode === "recovery" ? await seed() : safeEnv;
    const journal = {
      ...journalIO,
      unlink: vi.fn<typeof journalIO.unlink>().mockImplementation(async (path) => {
        if (mode === "recovery" && String(path).endsWith(".recovery.lock")) return journalIO.unlink(path);
        throw outage();
      }),
    };
    const message = await failure(runProviderCheck(env, { ...dependencies(), journal }, check));
    expect(message).toContain("account was deleted");
    expect(message).toContain("manually remove");
    expect(message).toContain("Do not rerun recovery");
    expect(message).not.toContain("CLERK_PROVIDER_CLEANUP_MANIFEST=");
    expect(users.deleteUser).toHaveBeenCalledExactlyOnceWith(saved.userId);
    expect(await readdir(directory)).toHaveLength(1);
    const [file] = await readdir(directory);
    expect(message).toContain(join(directory, file));
    expect(users.createUser).toHaveBeenCalledTimes(mode === "recovery" ? 0 : 1);
  });

  it("retains an already-deleted account's journal and instructs confirmation before removal", async () => {
    const env = await seed();
    users.getUser.mockRejectedValue(Object.assign(outage(), { status: 404 }));
    const message = await failure(runProviderCheck(env, dependencies(), check));
    expect(message).toContain("If already absent, confirm absence before manually removing");
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
  });

  it("does not create an account when journal directory setup fails", async () => {
    const journal = { ...journalIO, mkdir: vi.fn(async () => { throw new Error("disk unavailable"); }) };
    await expect(runProviderCheck(safeEnv, { ...dependencies(), journal }, check)).rejects.toThrow("disk unavailable");
    for (const call of [...Object.values(users), check]) expect(call).not.toHaveBeenCalled();
  });

  it("does not attempt lookup or deletion without a returned creation ID", async () => {
    users.createUser.mockRejectedValue(outage());
    const message = await failure(runProviderCheck(safeEnv, dependencies(), check));
    expect(message).toContain("outcome is unknown");
    expect(message).toContain("private intent journal");
    expect(message).toContain("Explicitly recover");
    expect(message).toContain(users.createUser.mock.calls[0][0].emailAddress[0]);
    expect(message).toContain(users.createUser.mock.calls[0][0].privateMetadata.wareiqProviderTest);
    expect(message).toContain("Do not retry creation until recovery confirms absence or deletes the verified fixture");
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    const [file] = await readdir(directory);
    expect(JSON.parse(await readFile(join(directory, file), "utf8"))).toEqual({
      state: "intent",
      runId: users.createUser.mock.calls[0][0].privateMetadata.wareiqProviderTest,
      email: users.createUser.mock.calls[0][0].emailAddress[0],
    });
  });

  it("retains a normal run's journal when setup and teardown both fail", async () => {
    check.mockRejectedValue(new Error("setup failed"));
    users.deleteUser.mockRejectedValue(outage());
    const message = await failure(runProviderCheck(safeEnv, dependencies(), check));
    const [file] = await readdir(directory);
    expect(message).toContain(join(directory, file));
    expect(message).toContain("pnpm test:auth:provider");
    expect(users.createUser).toHaveBeenCalledOnce();
    expect(users.deleteUser).toHaveBeenCalledOnce();
  });
});
