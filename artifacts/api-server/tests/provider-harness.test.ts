import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyPairAttestation, journalIO, runProviderCheck, type Manifest, type ProviderUsers,
} from "../provider-tests/harness";

// No Clerk/app import. Synthetic strings only; never read process.env.
const syntheticSecretKey = "sk_test_offline_fake";
const syntheticPublishableKey = "pk_test_offline_fake";
const safeEnv = {
  NODE_ENV: "test",
  CLERK_PROVIDER_TESTS: "isolated-development-only",
  CLERK_SECRET_KEY: syntheticSecretKey,
  CLERK_PUBLISHABLE_KEY: syntheticPublishableKey,
  CLERK_PROVIDER_KEY_PAIR_ATTESTATION: createKeyPairAttestation(
    syntheticSecretKey, syntheticPublishableKey,
  ),
};
const providerDetail = "FAKE_PRIVATE_PROVIDER_RESPONSE";
const outage = () => new Error(providerDetail);
const testBootId = "11111111-1111-4111-8111-111111111111";
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");
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
  const children: ChildProcess[] = [];
  let user: ReturnType<typeof account>;
  let users: {
    createUser: ReturnType<typeof vi.fn<ProviderUsers["createUser"]>>;
    getUser: ReturnType<typeof vi.fn<ProviderUsers["getUser"]>>;
    getUserList: ReturnType<typeof vi.fn<ProviderUsers["getUserList"]>>;
    deleteUser: ReturnType<typeof vi.fn<ProviderUsers["deleteUser"]>>;
  };
  const check = vi.fn<(manifest: Manifest) => Promise<void>>();
  const info = vi.fn();
  const dependencies = () => ({
    users,
    journalDirectory: directory,
    info,
    bootIdentityProbe: () => testBootId,
  });
  const recoveryEnv = () => ({
    ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: join(directory, "recovery.json"),
  });
  const lockPath = (env: ReturnType<typeof recoveryEnv>) =>
    `${env.CLERK_PROVIDER_CLEANUP_MANIFEST}.recovery.lock`;
  const lockActionEnv = (action: string) => ({
    ...recoveryEnv(), CLERK_PROVIDER_RECOVERY_LOCK_ACTION: action,
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
  function copiedRetryPath(message: string) {
    const assignment = message.match(/CLERK_PROVIDER_CLEANUP_MANIFEST=(.+?) pnpm test:auth:provider/)?.[1];
    if (!assignment) throw new Error("Retry command did not include a journal path assignment");
    return execFileSync("/bin/sh", [
      "-c",
      `CLERK_PROVIDER_CLEANUP_MANIFEST=${assignment} /bin/sh -c 'printf "%s" "$CLERK_PROVIDER_CLEANUP_MANIFEST"'`,
    ], { encoding: "utf8" });
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
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }));
    await rm(directory, { recursive: true, force: true });
  });

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

  it.each([
    ["a changed secret key", { CLERK_SECRET_KEY: "sk_test_offline_other" }],
    ["a changed publishable key", { CLERK_PUBLISHABLE_KEY: "pk_test_offline_other" }],
    ["a missing attestation", { CLERK_PROVIDER_KEY_PAIR_ATTESTATION: undefined }],
    ["a malformed attestation", { CLERK_PROVIDER_KEY_PAIR_ATTESTATION: "not-a-fingerprint" }],
  ])("refuses %s before provider, journal or application work", async (_name, override) => {
    for (const recovery of [false, true]) {
      const journal = {
        mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(),
      };
      await expect(runProviderCheck(
        { ...(recovery ? recoveryEnv() : safeEnv), ...override },
        { ...dependencies(), journal: journal as unknown as typeof journalIO }, check,
      )).rejects.toThrow("local pairing attestation");
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
    expect(info).toHaveBeenCalledExactlyOnceWith("Recovery complete: verified generated fixture deleted.");
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
    expect(JSON.parse(await readFile(lockPath(env), "utf8"))).toEqual({
      pid: expect.any(Number),
      token: expect.stringMatching(/^[a-f0-9-]{36}$/),
      bootId: testBootId,
    });

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

  it("does not allow clearing a lock created without boot identity evidence", async () => {
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

    const attempt = runProviderCheck(env, {
      ...dependencies(),
      bootIdentityProbe: () => undefined,
    }, check);
    await lookupStarted;

    const lock = lockPath(env);
    const lockContents = await readFile(lock, "utf8");
    expect(JSON.parse(lockContents)).not.toHaveProperty("bootId");

    const processProbe = vi.fn(() => "active" as const);
    await expect(runProviderCheck({
      ...env,
      CLERK_PROVIDER_RECOVERY_LOCK_ACTION: "clear-abandoned",
    }, {
      ...dependencies(),
      processProbe,
      bootIdentityProbe: () => testBootId,
    }, check)).rejects.toThrow("status is uncertain");

    expect(await readFile(lock, "utf8")).toBe(lockContents);
    expect(processProbe).not.toHaveBeenCalled();

    releaseLookup();
    await expect(attempt).rejects.toThrow("Cleanup failed or ownership check refused deletion");
    expect(await readFile(env.CLERK_PROVIDER_CLEANUP_MANIFEST, "utf8")).toContain(saved.userId);
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes recovery in separate processes while the first fake provider call is paused", async () => {
    const env = await seed();
    const pausedPath = join(directory, "holder-paused");
    const releasePath = join(directory, "release-holder");
    const holderResultPath = join(directory, "holder-result.json");
    const contenderResultPath = join(directory, "contender-result.json");
    const workerPath = fileURLToPath(new URL("../provider-tests/recovery-lock-worker.ts", import.meta.url));
    const launch = (role: "holder" | "contender", resultPath: string) => {
      const child = fork(workerPath, [
        role,
        env.CLERK_PROVIDER_CLEANUP_MANIFEST,
        directory,
        resultPath,
        pausedPath,
        releasePath,
      ], {
        execArgv: ["--import", tsx],
        // Do not inherit workspace credentials; the worker uses synthetic keys.
        env: { NODE_ENV: "test" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      return { child, exited, getStderr: () => stderr };
    };
    const holder = launch("holder", holderResultPath);

    await expect.poll(async () => {
      if (holder.child.exitCode !== null) throw new Error(`Holder exited early: ${holder.getStderr()}`);
      try { await readFile(pausedPath, "utf8"); return true; } catch { return false; }
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    expect(await readFile(join(directory, "holder-provider-called"), "utf8")).toBe("called");
    expect(JSON.parse(await readFile(lockPath(env), "utf8")).bootId)
      .toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

    const contender = launch("contender", contenderResultPath);
    expect(await contender.exited).toBe(0);
    const contenderResult = JSON.parse(await readFile(contenderResultPath, "utf8"));
    expect(contenderResult.error).toContain("Recovery already in progress");
    expect(contenderResult.error).toContain("no provider calls made");
    await expect(readFile(join(directory, "contender-provider-called"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    expect(await readFile(pausedPath, "utf8")).toBe("paused");

    await writeFile(releasePath, "release");
    expect(await holder.exited).toBe(0);
    const holderResult = JSON.parse(await readFile(holderResultPath, "utf8"));
    expect(holderResult.error).toContain("Cleanup failed or ownership check refused deletion");
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
  });

  it("excludes separate-process exact-email lookups for the same interrupted creation", async () => {
    const journalPath = join(directory, "interrupted-creation.json");
    const intent = { state: "intent", runId: saved.runId, email: saved.email };
    await writeFile(journalPath, JSON.stringify(intent), { mode: 0o600 });
    const pausedPath = join(directory, "holder-paused");
    const releasePath = join(directory, "release-holder");
    const holderResultPath = join(directory, "holder-result.json");
    const contenderResultPath = join(directory, "contender-result.json");
    const workerPath = fileURLToPath(new URL("../provider-tests/recovery-lock-worker.ts", import.meta.url));
    const launch = (role: "holder" | "contender", resultPath: string) => {
      const child = fork(workerPath, [
        role,
        journalPath,
        directory,
        resultPath,
        pausedPath,
        releasePath,
        "intent",
      ], {
        execArgv: ["--import", tsx],
        // Do not inherit workspace credentials; the worker uses synthetic keys.
        env: { NODE_ENV: "test" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      return { child, exited, getStderr: () => stderr };
    };
    const holder = launch("holder", holderResultPath);

    await expect.poll(async () => {
      if (holder.child.exitCode !== null) throw new Error(`Holder exited early: ${holder.getStderr()}`);
      try { await readFile(pausedPath, "utf8"); return true; } catch { return false; }
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "holder-exact-email-lookup.json"), "utf8")))
      .toEqual({ emailAddress: [saved.email], limit: 2 });

    const contender = launch("contender", contenderResultPath);
    expect(await contender.exited).toBe(0);
    const contenderResult = JSON.parse(await readFile(contenderResultPath, "utf8"));
    expect(contenderResult.error).toContain("Recovery already in progress");
    expect(contenderResult.error).toContain("no provider calls made");
    await expect(readFile(join(directory, "contender-provider-called"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(directory, "contender-exact-email-lookup.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual(intent);

    await writeFile(releasePath, "release");
    expect(await holder.exited).toBe(0);
    const holderResult = JSON.parse(await readFile(holderResultPath, "utf8"));
    expect(holderResult.error).toContain("Recovery lookup failed");
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual(intent);
  });

  it("inspects and explicitly clears a lock left by a crashed recovery process", async () => {
    const env = await seed();
    const pausedPath = join(directory, "unused-paused");
    const releasePath = join(directory, "unused-release");
    const workerPath = fileURLToPath(new URL("../provider-tests/recovery-lock-worker.ts", import.meta.url));
    const launch = (role: string, resultPath: string) => {
      const child = fork(workerPath, [
        role,
        env.CLERK_PROVIDER_CLEANUP_MANIFEST,
        directory,
        resultPath,
        pausedPath,
        releasePath,
      ], {
        execArgv: ["--import", tsx],
        // Do not inherit workspace credentials; the worker uses synthetic keys.
        env: { NODE_ENV: "test" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      return { child, exited };
    };

    const crashed = launch("crash-holder", join(directory, "crash-result.json"));
    const crashExit = await crashed.exited;
    expect(crashExit).toEqual({ code: null, signal: "SIGKILL" });
    expect(await readFile(join(directory, "crash-provider-started"), "utf8")).toBe("started");

    const lock = lockPath(env);
    const lockContents = await readFile(lock, "utf8");
    const ownerPid = JSON.parse(lockContents).pid as number;
    expect(ownerPid).toBe(crashed.child.pid);
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);

    const contenderResultPath = join(directory, "crash-contender-result.json");
    const contender = launch("contender", contenderResultPath);
    expect(await contender.exited).toEqual({ code: 0, signal: null });
    const contenderResult = JSON.parse(await readFile(contenderResultPath, "utf8"));
    expect(contenderResult.error).toContain("Recovery already in progress");
    expect(contenderResult.error).toContain("no provider calls made");
    expect(await readFile(lock, "utf8")).toBe(lockContents);
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    await expect(readFile(join(directory, "contender-provider-called"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const inspectResultPath = join(directory, "inspect-result.json");
    const inspector = launch("inspect", inspectResultPath);
    expect(await inspector.exited).toEqual({ code: 0, signal: null });
    const inspectResult = JSON.parse(await readFile(inspectResultPath, "utf8"));
    expect(inspectResult.success).toBe(true);
    expect(inspectResult.messages).toEqual([
      expect.stringContaining(`confirmed abandoned: process ${ownerPid} is not running`),
    ]);
    expect(await readFile(lock, "utf8")).toBe(lockContents);
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);

    const clearResultPath = join(directory, "clear-result.json");
    const directoryBeforeClear = await readdir(directory);
    const clearer = launch("clear-abandoned", clearResultPath);
    expect(await clearer.exited).toEqual({ code: 0, signal: null });
    const clearResult = JSON.parse(await readFile(clearResultPath, "utf8"));
    expect(clearResult.success).toBe(true);
    expect(clearResult.messages).toEqual([
      expect.stringContaining("Confirmed abandoned recovery lock removed"),
    ]);
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    expect(await readdir(directory)).toEqual(
      [...directoryBeforeClear.filter((name) => name !== "recovery.json.recovery.lock"), "clear-result.json"].sort(),
    );
    for (const name of ["inspect", "clear-abandoned"]) {
      await expect(readFile(join(directory, `${name}-provider-called`), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reports an active recovery and refuses to clear its lock", async () => {
    const inspectEnv = lockActionEnv("inspect");
    const lock = lockPath(inspectEnv);
    await writeFile(lock, JSON.stringify({
      pid: process.pid, token: saved.runId, bootId: testBootId,
    }), { mode: 0o600 });

    await runProviderCheck(inspectEnv, dependencies(), check);
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`active: process ${process.pid}`));
    expect(await readFile(lock, "utf8")).toContain(`"pid":${process.pid}`);

    await expect(runProviderCheck(
      { ...inspectEnv, CLERK_PROVIDER_RECOVERY_LOCK_ACTION: "clear-abandoned" },
      dependencies(),
      check,
    )).rejects.toThrow("The lock was not removed");
    expect(await readFile(lock, "utf8")).toContain(`"pid":${process.pid}`);
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("clears a lock only after an explicit action confirms its owner is gone", async () => {
    const inspectEnv = lockActionEnv("inspect");
    const lock = lockPath(inspectEnv);
    const contents = JSON.stringify({
      pid: 2_147_483_647, token: saved.runId, bootId: testBootId,
    });
    await writeFile(lock, contents, { mode: 0o600 });
    const processProbe = vi.fn(() => "abandoned" as const);
    const deps = { ...dependencies(), processProbe };

    await runProviderCheck(inspectEnv, deps, check);
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("confirmed abandoned"));
    expect(await readFile(lock, "utf8")).toBe(contents);

    info.mockClear();
    await runProviderCheck(
      { ...inspectEnv, CLERK_PROVIDER_RECOVERY_LOCK_ACTION: "clear-abandoned" },
      deps,
      check,
    );
    expect(processProbe).toHaveBeenCalledTimes(3); // Inspection, clear check, and immediate recheck.
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("No journal or provider account was changed"));
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("retains a lock when its process state is uncertain", async () => {
    const env = lockActionEnv("clear-abandoned");
    const lock = lockPath(env);
    const contents = JSON.stringify({
      pid: 2_147_483_647, token: saved.runId, bootId: testBootId,
    });
    await writeFile(lock, contents, { mode: 0o600 });

    await expect(runProviderCheck(
      env, { ...dependencies(), processProbe: () => "uncertain" }, check,
    )).rejects.toThrow("status is uncertain");
    expect(await readFile(lock, "utf8")).toBe(contents);
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{"],
    ["missing PID", JSON.stringify({ token: saved.runId })],
    ["missing token", JSON.stringify({ pid: process.pid })],
    ["invalid PID", JSON.stringify({ pid: 0, token: saved.runId })],
    ["invalid token", JSON.stringify({ pid: process.pid, token: "not-a-uuid" })],
  ])("inspects and refuses to clear a recovery lock with %s", async (_label, contents) => {
    const env = lockActionEnv("inspect");
    const manifestPath = env.CLERK_PROVIDER_CLEANUP_MANIFEST!;
    const manifestContents = JSON.stringify(saved);
    const lock = lockPath(env);
    await writeFile(manifestPath, manifestContents, { mode: 0o600 });
    await writeFile(lock, contents, { mode: 0o600 });

    const processProbe = vi.fn(() => "abandoned" as const);
    const journal = {
      ...journalIO,
      mkdir: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn(),
      writeFile: vi.fn(),
    };
    const deps = { ...dependencies(), journal: journal as unknown as typeof journalIO, processProbe };

    await runProviderCheck(env, deps, check);
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("status is uncertain"));
    expect(await readFile(lock, "utf8")).toBe(contents);

    info.mockClear();
    await expect(runProviderCheck(
      { ...env, CLERK_PROVIDER_RECOVERY_LOCK_ACTION: "clear-abandoned" },
      deps,
      check,
    )).rejects.toThrow("status is uncertain");

    expect(await readFile(lock, "utf8")).toBe(contents);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestContents);
    expect(processProbe).not.toHaveBeenCalled();
    expect(journal.mkdir).not.toHaveBeenCalled();
    expect(journal.rename).not.toHaveBeenCalled();
    expect(journal.unlink).not.toHaveBeenCalled();
    expect(journal.writeFile).not.toHaveBeenCalled();
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("identifies a prior-boot lock without probing a reused active PID", async () => {
    const inspectEnv = lockActionEnv("inspect");
    const lock = lockPath(inspectEnv);
    const contents = JSON.stringify({
      pid: process.pid, token: saved.runId, bootId: "22222222-2222-4222-8222-222222222222",
    });
    await writeFile(lock, contents, { mode: 0o600 });
    const processProbe = vi.fn(() => "active" as const);

    await runProviderCheck(inspectEnv, {
      ...dependencies(),
      processProbe,
      bootIdentityProbe: () => testBootId,
    }, check);

    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("prior host boot"));
    expect(processProbe).not.toHaveBeenCalled();
    expect(await readFile(lock, "utf8")).toBe(contents);

    await runProviderCheck({
      ...inspectEnv,
      CLERK_PROVIDER_RECOVERY_LOCK_ACTION: "clear-abandoned",
    }, {
      ...dependencies(),
      processProbe,
      bootIdentityProbe: () => testBootId,
    }, check);
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(processProbe).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ["missing lock boot identity", { pid: 2_147_483_647, token: saved.runId }, testBootId],
    ["malformed lock boot identity", {
      pid: 2_147_483_647, token: saved.runId, bootId: "not-a-boot-id",
    }, testBootId],
    ["missing current boot identity", {
      pid: 2_147_483_647, token: saved.runId, bootId: testBootId,
    }, undefined],
    ["malformed current boot identity", {
      pid: 2_147_483_647, token: saved.runId, bootId: testBootId,
    }, "unknown"],
  ])("never clears a lock with %s", async (_description, lockRecord, currentBootId) => {
    const env = lockActionEnv("clear-abandoned");
    const lock = lockPath(env);
    const contents = JSON.stringify(lockRecord);
    await writeFile(lock, contents, { mode: 0o600 });
    const processProbe = vi.fn(() => "abandoned" as const);

    await expect(runProviderCheck(env, {
      ...dependencies(),
      processProbe,
      bootIdentityProbe: () => currentBootId,
    }, check)).rejects.toThrow("status is uncertain");

    expect(await readFile(lock, "utf8")).toBe(contents);
    expect(processProbe).not.toHaveBeenCalled();
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(users.getUserList).not.toHaveBeenCalled();
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
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
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "Recovery complete: exact-email lookup found no account; intent journal removed. No account was changed.",
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ["empty results with a positive count", { data: [], totalCount: 1 }],
    ["non-empty results with a zero count", { data: [account(saved)], totalCount: 0 }],
  ] satisfies Array<[string, Awaited<ReturnType<ProviderUsers["getUserList"]>>]>)(
    "retains an intent when recovery returns %s",
    async (_description, result) => {
      const path = join(directory, "conflicting-intent.json");
      const intentContents = JSON.stringify({ state: "intent", runId: saved.runId, email: saved.email });
      await writeFile(path, intentContents, { mode: 0o600 });
      users.getUserList.mockResolvedValueOnce(result);
      const message = await failure(runProviderCheck(
        { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path },
        dependencies(),
        check,
      ));

      expect(message).toContain("count did not match its result list");
      expect(message).toContain("Retain the intent journal");
      expect(message).toContain("no account was changed");
      expect(message).not.toContain("Recovery complete");
      expect(users.getUserList).toHaveBeenCalledExactlyOnceWith({ emailAddress: [saved.email], limit: 2 });
      expect(users.createUser).not.toHaveBeenCalled();
      expect(users.deleteUser).not.toHaveBeenCalled();
      expect(users.getUser).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(intentContents);
      expect(await readdir(directory)).toEqual(["conflicting-intent.json"]);
    },
  );

  it("retains an absent intent and reports journal removal failure without provider details", async () => {
    const path = join(directory, "absent-intent-unlink-failure.json");
    const intent = { state: "intent", runId: saved.runId, email: saved.email };
    await writeFile(path, JSON.stringify(intent), { mode: 0o600 });
    users.getUserList.mockResolvedValueOnce({ data: [], totalCount: 0 });
    const journal = {
      ...journalIO,
      unlink: vi.fn<typeof journalIO.unlink>().mockImplementation(async (target) => {
        if (target === path) throw outage();
        return journalIO.unlink(target);
      }),
    };
    const message = await failure(runProviderCheck(
      { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path },
      { ...dependencies(), journal },
      check,
    ));

    expect(message).toContain("No account matched the exact generated email");
    expect(message).toContain("The intent journal could not be removed");
    expect(message).toContain("No account was changed");
    expect(message).not.toContain("Recovery complete");
    expect(users.getUserList).toHaveBeenCalledExactlyOnceWith({ emailAddress: [saved.email], limit: 2 });
    expect(users.createUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(intent);
    expect(await readdir(directory)).toEqual([path.split("/").at(-1)]);
  });

  it.each(["matching account", "no matching account"])(
    "retains changed intent evidence after the exact-email lookup finds %s",
    async (lookupOutcome) => {
      const path = join(directory, "changed-intent-during-lookup.json");
      const originalIntent = { state: "intent", runId: saved.runId, email: saved.email };
      const changedIntent = {
        state: "intent",
        runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        email: "wareiq-provider-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb@example.com",
      };
      const changedContents = JSON.stringify(changedIntent);
      await writeFile(path, JSON.stringify(originalIntent), { mode: 0o600 });
      users.getUserList.mockImplementationOnce(async () => {
        await writeFile(path, changedContents, { mode: 0o600 });
        return lookupOutcome === "matching account"
          ? { data: [user], totalCount: 1 }
          : { data: [], totalCount: 0 };
      });

      const message = await failure(runProviderCheck(
        { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: path }, dependencies(), check,
      ));

      expect(message).toContain("journal changed during exact-email lookup");
      expect(message).not.toContain("Recovery complete");
      expect(await readFile(path, "utf8")).toBe(changedContents);
      expect(users.getUserList).toHaveBeenCalledExactlyOnceWith({
        emailAddress: [originalIntent.email],
        limit: 2,
      });
      expect(users.createUser).not.toHaveBeenCalled();
      expect(users.getUser).not.toHaveBeenCalled();
      expect(users.deleteUser).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    },
  );

  it("prints distinct, safe recovery results through the default command output", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const defaultDependencies = { users, journalDirectory: directory };
    try {
      const fixtureEnv = await seed();
      await runProviderCheck(fixtureEnv, defaultDependencies, check);

      const absentPath = join(directory, "absent-intent.json");
      await writeFile(
        absentPath,
        JSON.stringify({ state: "intent", runId: saved.runId, email: saved.email }),
        { mode: 0o600 },
      );
      users.getUserList.mockResolvedValueOnce({ data: [], totalCount: 0 });
      await runProviderCheck(
        { ...safeEnv, CLERK_PROVIDER_CLEANUP_MANIFEST: absentPath },
        defaultDependencies,
        check,
      );

      const messages = output.mock.calls.map(([message]) => String(message));
      expect(messages).toEqual([
        "Recovery complete: verified generated fixture deleted.",
        "Recovery complete: exact-email lookup found no account; intent journal removed. No account was changed.",
      ]);
      expect(new Set(messages).size).toBe(2);
      const printed = messages.join("\n");
      expect(printed).not.toContain(providerDetail);
      expect(printed).not.toContain(syntheticSecretKey);
      expect(printed).not.toContain(syntheticPublishableKey);
      expect(printed).not.toMatch(/(?:bearer\s+\S+|\b(?:jwt|token)\b)/i);
      expect(users.createUser).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it("shows safe recovery refusals in provider-test command output", async () => {
    const providerTestsDirectory = fileURLToPath(new URL("../provider-tests/", import.meta.url));
    const fixturePath = join(providerTestsDirectory, `refusal-output-${randomUUID()}.test.ts`);
    const journalPath = join(directory, "command-refusal.json");
    const responseFixture = [
      providerDetail,
      "Bearer synthetic-provider-token",
      syntheticSecretKey,
      syntheticPublishableKey,
    ].join(" ");
    const fixture = `
      import { writeFile } from "node:fs/promises";
      import { it } from "vitest";
      import { createKeyPairAttestation, runProviderCheck } from "./harness";

      it.skipIf(process.env.PROVIDER_REFUSAL_COMMAND_TEST !== "1")(
        "prints a safe recovery refusal",
        async () => {
          const secretKey = process.env.CLERK_SECRET_KEY!;
          const publishableKey = process.env.CLERK_PUBLISHABLE_KEY!;
          const path = process.env.PROVIDER_REFUSAL_JOURNAL_PATH!;
          const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
          await writeFile(path, JSON.stringify({
            state: "intent",
            runId,
            email: "wareiq-provider-" + runId + "@example.com",
          }), { mode: 0o600 });

          const users = {
            createUser: async () => { throw new Error("Unexpected account creation"); },
            getUser: async () => { throw new Error("Unexpected account lookup"); },
            getUserList: async () => ({
              data: [{
                id: "user_offline_fixture",
                privateMetadata: { wareiqProviderTest: process.env.PROVIDER_RESPONSE_FIXTURE },
                emailAddresses: [{ emailAddress: process.env.PROVIDER_RESPONSE_FIXTURE! }],
              }],
              totalCount: 1,
            }),
            deleteUser: async () => { throw new Error("Unexpected account deletion"); },
          };

          await runProviderCheck({
            NODE_ENV: "test",
            CLERK_PROVIDER_TESTS: "isolated-development-only",
            CLERK_SECRET_KEY: secretKey,
            CLERK_PUBLISHABLE_KEY: publishableKey,
            CLERK_PROVIDER_KEY_PAIR_ATTESTATION:
              createKeyPairAttestation(secretKey, publishableKey),
            CLERK_PROVIDER_CLEANUP_MANIFEST: path,
          } as NodeJS.ProcessEnv, { users }, async () => {});
        },
      );
    `;
    await writeFile(fixturePath, fixture, { mode: 0o600 });

    try {
      const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
      const command = spawn("pnpm", [
        "test:auth:provider", "--", fixturePath,
      ], {
        cwd: workspaceRoot,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: "test",
          CLERK_PROVIDER_TESTS: "isolated-development-only",
          CLERK_SECRET_KEY: syntheticSecretKey,
          CLERK_PUBLISHABLE_KEY: syntheticPublishableKey,
          CLERK_PROVIDER_KEY_PAIR_ATTESTATION: safeEnv.CLERK_PROVIDER_KEY_PAIR_ATTESTATION,
          PROVIDER_REFUSAL_COMMAND_TEST: "1",
          PROVIDER_REFUSAL_JOURNAL_PATH: journalPath,
          PROVIDER_RESPONSE_FIXTURE: responseFixture,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      command.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
      command.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => command.kill("SIGKILL"), 60_000);
        command.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        command.once("exit", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });

      expect(exitCode).toBe(1);
      expect(output).toContain(
        "Recovery refused: the exact generated email did not identify one account with the matching private run marker.",
      );
      expect(output).toContain("Retain the intent journal; no account was changed.");
      expect(output).not.toContain(providerDetail);
      expect(output).not.toContain("synthetic-provider-token");
      expect(output).not.toContain(syntheticSecretKey);
      expect(output).not.toContain(syntheticPublishableKey);
      expect(output).not.toMatch(/bearer\s+\S+/i);
      expect(users.getUserList).not.toHaveBeenCalled();
      expect(users.createUser).not.toHaveBeenCalled();
      expect(users.getUser).not.toHaveBeenCalled();
      expect(users.deleteUser).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    } finally {
      await rm(fixturePath, { force: true });
    }
  }, 60_000);

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
    expect(copiedRetryPath(message)).toBe(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    expect(message).toContain("same Development instance");
    await retained(env.CLERK_PROVIDER_CLEANUP_MANIFEST);
    if (stage === "ownership lookup") expect(users.deleteUser).not.toHaveBeenCalled();
    await runProviderCheck(env, dependencies(), check); // Follow the printed recovery instructions.
    expect(await readdir(directory)).toEqual([]);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("prints a shell-safe retry command for unusual recovery journal paths", async () => {
    const path = join(directory, "journal with $HOME $(printf expanded) and 'quotes'.json");
    await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
    users.getUser.mockRejectedValueOnce(outage());

    const message = await failure(runProviderCheck({
      ...safeEnv,
      CLERK_PROVIDER_CLEANUP_MANIFEST: path,
    }, dependencies(), check));
    expect(copiedRetryPath(message)).toBe(path);
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it("prints a shell-safe retry command after account creation has an unknown outcome", async () => {
    const journalDirectory = join(directory, "journal with $HOME $(printf expanded) and 'quotes'");
    users.createUser.mockRejectedValueOnce(outage());

    const message = await failure(runProviderCheck(
      safeEnv,
      { ...dependencies(), journalDirectory },
      check,
    ));
    const copiedPath = copiedRetryPath(message);

    expect(copiedPath).toMatch(new RegExp(`^${journalDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+\\.json$`));
    expect(message).toContain(`private intent journal is ${copiedPath}.`);
    expect(users.getUser).not.toHaveBeenCalled();
    expect(users.deleteUser).not.toHaveBeenCalled();
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
