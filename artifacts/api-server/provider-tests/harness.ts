import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Manifest = { userId: string; runId: string; email: string };
type CreationIntent = { state: "intent"; runId: string; email: string };
type RecoveryRecord = Manifest | CreationIntent;
type TestUser = {
  id: string;
  privateMetadata: Record<string, unknown>;
  emailAddresses: { emailAddress: string }[];
};
export type ProviderUsers = {
  createUser(params: {
    emailAddress: string[];
    skipPasswordRequirement: boolean;
    publicMetadata: { role: string };
    privateMetadata: { wareiqProviderTest: string };
  }): Promise<TestUser>;
  getUser(id: string): Promise<TestUser>;
  getUserList(params: {
    emailAddress: string[];
    limit: number;
  }): Promise<{ data: TestUser[]; totalCount: number }>;
  deleteUser(id: string): Promise<unknown>;
};
export const journalIO = { mkdir, readFile, rename, unlink, writeFile };
function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
const keyPairAttestationVersion = "wareiq-clerk-provider-key-pair-v1\0";
type Dependencies = {
  users: ProviderUsers;
  journal?: typeof journalIO;
  journalDirectory?: string;
  info?: (message: string) => void;
  processProbe?: (pid: number) => RecoveryProcessState;
  bootIdentityProbe?: () => string | undefined | Promise<string | undefined>;
};
type RecoveryProcessState = "active" | "abandoned" | "uncertain";
type RecoveryLockStatus =
  | { state: "absent" }
  | { state: "active"; pid: number }
  | { state: "abandoned"; pid: number; contents: string; priorBoot: boolean }
  | { state: "uncertain"; reason: string };
const bootIdentityPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function normalizeBootIdentity(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return bootIdentityPattern.test(normalized) ? normalized : undefined;
}

async function probeHostBootIdentity() {
  try {
    return normalizeBootIdentity(await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
  } catch {
    return undefined;
  }
}

// Clerk's secret key does not expose its instance ID locally. This fingerprint
// binds the exact pair an operator has verified in the Clerk dashboard.
export function createKeyPairAttestation(secretKey: string, publishableKey: string) {
  return createHash("sha256")
    .update(keyPairAttestationVersion)
    .update(secretKey)
    .update("\0")
    .update(publishableKey)
    .digest("hex");
}

export function assertKeyPairAttestation(
  secretKey: string,
  publishableKey: string,
  attestation: string | undefined,
) {
  const expected = createKeyPairAttestation(secretKey, publishableKey);
  if (!attestation || !/^[a-f0-9]{64}$/.test(attestation)
    || !timingSafeEqual(Buffer.from(attestation, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("Clerk checks refused: configured keys do not match the local pairing attestation. See docs/authorization-regression-tests.md.");
  }
}

export function createConfiguredKeyPairAttestation(
  env: { CLERK_SECRET_KEY?: string; CLERK_PUBLISHABLE_KEY?: string },
) {
  const { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: publishableKey } = env;
  if (!secretKey?.startsWith("sk_test_") || !publishableKey?.startsWith("pk_test_")) {
    throw new Error("Configured Clerk keys must both be development keys.");
  }
  return createKeyPairAttestation(secretKey, publishableKey);
}

export function runKeyPairFingerprintCommand(
  env: { CLERK_SECRET_KEY?: string; CLERK_PUBLISHABLE_KEY?: string },
  writeOutput: (text: string) => void,
  writeError: (text: string) => void,
) {
  try {
    writeOutput(`${createConfiguredKeyPairAttestation(env)}\n`);
    return 0;
  } catch {
    writeError("Cannot generate fingerprint: configure both Clerk development keys first.\n");
    return 1;
  }
}

// Explicit input makes offline refusal tests independent of workspace secrets.
export function preflight(env: NodeJS.ProcessEnv) {
  if (env.CLERK_PROVIDER_TESTS !== "isolated-development-only"
    || env.NODE_ENV === "production"
    || !env.CLERK_SECRET_KEY?.startsWith("sk_test_")
    || !env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error("Provider checks require explicit opt-in and development-only Clerk keys. See docs/authorization-regression-tests.md.");
  }
  assertKeyPairAttestation(
    env.CLERK_SECRET_KEY, env.CLERK_PUBLISHABLE_KEY, env.CLERK_PROVIDER_KEY_PAIR_ATTESTATION,
  );
}

// Provider exceptions can contain tokens; never expose their details or cause.
export async function provider<T>(label: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error(`Clerk development check failed during ${label}; provider details suppressed.`); }
}

function probeRecoveryProcess(pid: number): RecoveryProcessState {
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "active";
    if (code === "ESRCH") return "abandoned";
    return "uncertain";
  }
}

async function recoveryLockStatus(
  lockPath: string,
  journal: typeof journalIO,
  processProbe: (pid: number) => RecoveryProcessState,
  bootIdentityProbe: () => string | undefined | Promise<string | undefined>,
): Promise<RecoveryLockStatus> {
  let contents: string;
  try {
    contents = await journal.readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "uncertain", reason: "the lock file could not be read" };
  }
  let lock: unknown;
  try { lock = JSON.parse(contents); }
  catch { return { state: "uncertain", reason: "the lock file is malformed" }; }
  if (!lock || typeof lock !== "object") {
    return { state: "uncertain", reason: "the lock file is malformed" };
  }
  const { pid, token, bootId } = lock as { pid?: unknown; token?: unknown; bootId?: unknown };
  if (!Number.isSafeInteger(pid) || (pid as number) < 1
    || typeof token !== "string"
    || !bootIdentityPattern.test(token)) {
    return { state: "uncertain", reason: "the lock file has an invalid owner record" };
  }
  const recordedBootId = normalizeBootIdentity(bootId);
  if (!recordedBootId) {
    return { state: "uncertain", reason: "the lock has no verifiable host-boot identity" };
  }
  const currentBootId = normalizeBootIdentity(await bootIdentityProbe());
  if (!currentBootId) {
    return { state: "uncertain", reason: "the current host-boot identity could not be verified" };
  }
  if (recordedBootId !== currentBootId) {
    return { state: "abandoned", pid: pid as number, contents, priorBoot: true };
  }
  const processState = processProbe(pid as number);
  if (processState === "active") return { state: "active", pid: pid as number };
  if (processState === "abandoned") {
    return { state: "abandoned", pid: pid as number, contents, priorBoot: false };
  }
  return { state: "uncertain", reason: "the recorded process state could not be confirmed" };
}

function recoveryLockMessage(status: RecoveryLockStatus, lockPath: string) {
  switch (status.state) {
    case "absent":
      return `No recovery lock exists at ${lockPath}.`;
    case "active":
      return `Recovery lock is active: process ${status.pid} is still running. Do not clear it.`;
    case "abandoned":
      if (status.priorBoot) {
        return `Recovery lock is confirmed abandoned: it belongs to a prior host boot, so process ${status.pid} cannot own a process on this boot. Use CLERK_PROVIDER_RECOVERY_LOCK_ACTION=clear-abandoned in a separate command to clear it.`;
      }
      return `Recovery lock is confirmed abandoned: process ${status.pid} is not running. Use CLERK_PROVIDER_RECOVERY_LOCK_ACTION=clear-abandoned in a separate command to clear it.`;
    case "uncertain":
      return `Recovery lock status is uncertain because ${status.reason}. Do not clear it; investigate manually.`;
  }
}

async function handleRecoveryLockAction(
  action: "inspect" | "clear-abandoned",
  lockPath: string,
  journal: typeof journalIO,
  processProbe: (pid: number) => RecoveryProcessState,
  bootIdentityProbe: () => string | undefined | Promise<string | undefined>,
  info: (message: string) => void,
) {
  const status = await recoveryLockStatus(lockPath, journal, processProbe, bootIdentityProbe);
  if (action === "inspect") {
    info(recoveryLockMessage(status, lockPath));
    return;
  }
  if (status.state !== "abandoned") {
    throw new Error(`${recoveryLockMessage(status, lockPath)} The lock was not removed.`);
  }
  const confirmation = await recoveryLockStatus(lockPath, journal, processProbe, bootIdentityProbe);
  if (confirmation.state !== "abandoned" || confirmation.contents !== status.contents) {
    throw new Error(`${recoveryLockMessage(confirmation, lockPath)} The lock changed during confirmation and was not removed.`);
  }
  try {
    await journal.unlink(lockPath);
  } catch {
    throw new Error(`Confirmed abandoned lock could not be removed at ${lockPath}; no provider calls made.`);
  }
  info(`Confirmed abandoned recovery lock removed at ${lockPath}. No journal or provider account was changed.`);
}

function parseRecoveryRecord(text: string): RecoveryRecord {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Invalid manifest");
  const { userId, runId, email, state } = value as Partial<Manifest & CreationIntent>;
  if (typeof runId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)
    || email !== `wareiq-provider-${runId}@example.com`) {
    throw new Error("Invalid manifest");
  }
  if (state === "intent" && userId === undefined) return { state, runId, email };
  if (state === undefined && typeof userId === "string" && userId)
    return { userId, runId, email };
  throw new Error("Invalid manifest");
}

async function persistManifest(path: string, manifest: Manifest, journal: typeof journalIO) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await journal.writeFile(temporaryPath, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    await journal.rename(temporaryPath, path);
  } catch {
    try { await journal.unlink(temporaryPath); } catch { /* Preserve the original intent. */ }
    throw new Error("Cleanup journal update failed; the original intent journal was retained.");
  }
}

async function assertRecoveryJournalUnchanged(
  path: string,
  expectedContents: string,
  journal: typeof journalIO,
) {
  let currentContents: string;
  try {
    currentContents = await journal.readFile(path, "utf8");
  } catch {
    throw new Error("Recovery refused: journal could not be re-read after exact-email lookup. No account was changed; retain the journal and investigate.");
  }
  if (currentContents !== expectedContents) {
    throw new Error("Recovery refused: journal changed during exact-email lookup. Retain the current journal; no account was changed.");
  }
}

// Shared by the opt-in live command and the offline fault-injection suite.
// A single finally covers journal persistence, app setup and assertion failures.
export async function runProviderCheck(
  env: NodeJS.ProcessEnv,
  dependencies: Dependencies,
  check: (manifest: Manifest) => Promise<void>,
) {
  preflight(env);
  const { users, journal = journalIO, info = console.info } = dependencies;
  const recovery = env.CLERK_PROVIDER_CLEANUP_MANIFEST;
  const lockAction = env.CLERK_PROVIDER_RECOVERY_LOCK_ACTION;
  if (lockAction === "inspect" || lockAction === "clear-abandoned") {
    if (!recovery) {
      throw new Error("Set CLERK_PROVIDER_CLEANUP_MANIFEST to the recovery journal whose lock should be inspected.");
    }
  } else if (lockAction !== undefined) {
    throw new Error("Invalid CLERK_PROVIDER_RECOVERY_LOCK_ACTION; use inspect or clear-abandoned.");
  }
  let manifest: Manifest | undefined;
  let journalWritten = false;
  let recoveryLockPath: string | undefined;
  let recoveryLockAcquired = false;
  const runId = randomUUID();
  const path = recovery
    ? resolve(recovery)
    : resolve(dependencies.journalDirectory ?? ".cache/clerk-provider", `${runId}.json`);
  const processProbe = dependencies.processProbe ?? probeRecoveryProcess;
  const bootIdentityProbe = dependencies.bootIdentityProbe ?? probeHostBootIdentity;
  if (lockAction === "inspect" || lockAction === "clear-abandoned") {
    await handleRecoveryLockAction(
      lockAction,
      `${path}.recovery.lock`,
      journal,
      processProbe,
      bootIdentityProbe,
      info,
    );
    return;
  }

  async function cleanup() {
    if (!manifest) return;
    const target = manifest;
    let deleted = false;
    try {
      const user = await provider("cleanup ownership check", () => users.getUser(manifest!.userId));
      if (!ownsFixture(user, manifest)) {
        throw new Error("Cleanup refused: account does not match this generated test manifest.");
      }
      await provider("generated account deletion", () => users.deleteUser(user.id));
      deleted = true;
      // No journal exists if persistence failed before creating the file.
      // Attempt unlink anyway: a failed write can also leave a partial file.
      try { await journal.unlink(path); }
      catch (error) {
        if (journalWritten || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      manifest = undefined;
      if (recovery) info("Recovery complete: verified generated fixture deleted.");
    } catch {
      if (deleted) {
        throw new Error(`Cleanup incomplete: generated account was deleted, but journal removal failed. Confirm its absence in the same Development instance, then manually remove ${path}. Do not rerun recovery for an already-deleted account.`);
      }
      const instruction = journalWritten
        ? `Retain ${path}. Retry against the same Development instance with CLERK_PROVIDER_TESTS=isolated-development-only CLERK_PROVIDER_CLEANUP_MANIFEST=${shellQuote(path)} pnpm test:auth:provider. If ownership differs, do not alter the journal or delete the account. If already absent, confirm absence before manually removing the journal.`
        : `No reliable recovery journal was saved. In the same Development instance, verify only generated user ${target.userId}, email ${target.email}, private run marker ${target.runId} before manual deletion. Do not bulk-delete accounts. Remove any partial journal at ${path} only after confirming deletion.`;
      throw new Error(`Cleanup failed or ownership check refused deletion. ${instruction} Provider details suppressed.`);
    }
  }

  try {
    if (recovery) {
      recoveryLockPath = `${path}.recovery.lock`;
      try {
        const bootId = normalizeBootIdentity(await bootIdentityProbe());
        await journal.writeFile(
          recoveryLockPath,
          JSON.stringify({
            pid: process.pid,
            token: randomUUID(),
            ...(bootId ? { bootId } : {}),
          }),
          { mode: 0o600, flag: "wx" },
        );
        recoveryLockAcquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Recovery already in progress or a prior recovery lock remains at ${recoveryLockPath}; no provider calls made and the journal at ${path} was retained. Inspect it with CLERK_PROVIDER_RECOVERY_LOCK_ACTION=inspect. Only after it reports a confirmed abandoned process may you explicitly clear it with CLERK_PROVIDER_RECOVERY_LOCK_ACTION=clear-abandoned. Never clear an active or uncertain lock.`);
        }
        throw new Error(`Could not acquire the recovery lock at ${recoveryLockPath}; no provider calls made and the journal at ${path} was retained.`);
      }
      let record: RecoveryRecord;
      let recordContents: string;
      try {
        recordContents = await journal.readFile(path, "utf8");
        record = parseRecoveryRecord(recordContents);
      }
      catch {
        throw new Error("Recovery journal is unreadable or invalid; no provider calls made. Retain the journal and verify the original generated fixture in the same Development instance; do not retarget it.");
      }
      journalWritten = true;
      if ("state" in record) {
        let result: { data: TestUser[]; totalCount: number };
        try {
          result = await provider("creation recovery lookup", () =>
            users.getUserList({ emailAddress: [record.email], limit: 2 }));
        } catch {
          throw new Error("Recovery lookup failed; no account was changed. Retain the intent journal and retry explicitly against the same Development instance. Provider details suppressed.");
        }
        if (!result || !Array.isArray(result.data) || !Number.isInteger(result.totalCount)) {
          throw new Error("Recovery refused: provider returned an invalid exact-email result. Retain the intent journal; no account was changed.");
        }
        await assertRecoveryJournalUnchanged(path, recordContents, journal);
        if (result.totalCount !== result.data.length) {
          throw new Error("Recovery refused: exact-email lookup count did not match its result list. Retain the intent journal; no account was changed.");
        }
        if (result.totalCount === 0 && result.data.length === 0) {
          try { await journal.unlink(path); }
          catch {
            throw new Error(`No account matched the exact generated email. The intent journal could not be removed; confirm absence in the same Development instance, then manually remove ${path}. No account was changed.`);
          }
          info("Recovery complete: exact-email lookup found no account; intent journal removed. No account was changed.");
          return;
        }
        if (result.totalCount !== 1 || result.data.length !== 1
          || !ownsFixture(result.data[0], { userId: result.data[0].id, runId: record.runId, email: record.email })) {
          throw new Error("Recovery refused: the exact generated email did not identify one account with the matching private run marker. Retain the intent journal; no account was changed.");
        }
        manifest = { userId: result.data[0].id, runId: record.runId, email: record.email };
        await persistManifest(path, manifest, journal);
      } else {
        manifest = record;
      }
      return; // finally performs ID-scoped cleanup; no account creation or access checks.
    }
    await journal.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const email = `wareiq-provider-${runId}@example.com`;
    const intent: CreationIntent = { state: "intent", runId, email };
    try {
      await journal.writeFile(path, JSON.stringify(intent), { mode: 0o600, flag: "wx" });
      journalWritten = true;
    } catch {
      throw new Error("Development check stopped: private creation intent could not be saved; no provider account was created.");
    }
    let user: TestUser;
    try {
      user = await provider("disposable account creation", () => users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        publicMetadata: { role: "admin" },
        privateMetadata: { wareiqProviderTest: runId },
      }));
    } catch {
      throw new Error(`Account creation did not return an ID; its outcome is unknown. The private intent journal is ${path}. Explicitly recover it against the same Development instance with CLERK_PROVIDER_TESTS=isolated-development-only CLERK_PROVIDER_CLEANUP_MANIFEST=${shellQuote(path)} pnpm test:auth:provider. Recovery checks only exact generated email ${email} and private run marker ${runId}; it never creates another account. Do not retry creation until recovery confirms absence or deletes the verified fixture. Provider details suppressed.`);
    }
    manifest = { userId: user.id, runId, email };
    try {
      await persistManifest(path, manifest, journal);
    } catch {
      throw new Error("Development check stopped: cleanup journal update failed; ID-scoped cleanup was attempted; provider details suppressed.");
    }
    info(`Disposable account cleanup manifest: ${path}`);
    await check(manifest);
  } finally {
    let cleanupError: unknown;
    try { await cleanup(); } catch (error) { cleanupError = error; }
    let lockReleaseFailed = false;
    if (recoveryLockAcquired && recoveryLockPath) {
      try { await journal.unlink(recoveryLockPath); }
      catch { lockReleaseFailed = true; }
    }
    if (cleanupError && lockReleaseFailed) {
      throw new Error(`${String(cleanupError)} Recovery lock could not be removed; verify no recovery is running before manually removing ${recoveryLockPath}.`);
    }
    if (cleanupError) throw cleanupError;
    if (lockReleaseFailed) {
      throw new Error(`Recovery finished, but its lock could not be removed. Verify no recovery is running before manually removing ${recoveryLockPath}.`);
    }
  }
}

function ownsFixture(user: TestUser, manifest: Manifest) {
  return typeof user.id === "string"
    && user.id.length > 0
    && user.id === manifest.userId
    && user.privateMetadata.wareiqProviderTest === manifest.runId
    && user.emailAddresses.length === 1
    && user.emailAddresses[0].emailAddress === manifest.email
    && /^wareiq-provider-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@example\.com$/.test(manifest.email);
}
