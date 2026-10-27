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
const keyPairAttestationVersion = "wareiq-clerk-provider-key-pair-v1\0";
type Dependencies = {
  users: ProviderUsers;
  journal?: typeof journalIO;
  journalDirectory?: string;
  info?: (message: string) => void;
};

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

// Explicit input makes offline refusal tests independent of workspace secrets.
export function preflight(env: NodeJS.ProcessEnv) {
  if (env.CLERK_PROVIDER_TESTS !== "isolated-development-only"
    || env.NODE_ENV === "production"
    || !env.CLERK_SECRET_KEY?.startsWith("sk_test_")
    || !env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error("Provider checks require explicit opt-in and development-only Clerk keys. See docs/authorization-regression-tests.md.");
  }
  const attestation = env.CLERK_PROVIDER_KEY_PAIR_ATTESTATION;
  const expected = createKeyPairAttestation(env.CLERK_SECRET_KEY, env.CLERK_PUBLISHABLE_KEY);
  if (!attestation || !/^[a-f0-9]{64}$/.test(attestation)
    || !timingSafeEqual(Buffer.from(attestation, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("Provider checks refused: configured Clerk keys do not match the local pairing attestation. See docs/authorization-regression-tests.md.");
  }
}

// Provider exceptions can contain tokens; never expose their details or cause.
export async function provider<T>(label: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error(`Clerk development check failed during ${label}; provider details suppressed.`); }
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
  let manifest: Manifest | undefined;
  let journalWritten = false;
  let recoveryLockPath: string | undefined;
  let recoveryLockAcquired = false;
  const runId = randomUUID();
  const path = recovery
    ? resolve(recovery)
    : resolve(dependencies.journalDirectory ?? ".cache/clerk-provider", `${runId}.json`);

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
        ? `Retain ${path}. Retry against the same Development instance with CLERK_PROVIDER_TESTS=isolated-development-only CLERK_PROVIDER_CLEANUP_MANIFEST=${JSON.stringify(path)} pnpm test:auth:provider. If ownership differs, do not alter the journal or delete the account. If already absent, confirm absence before manually removing the journal.`
        : `No reliable recovery journal was saved. In the same Development instance, verify only generated user ${target.userId}, email ${target.email}, private run marker ${target.runId} before manual deletion. Do not bulk-delete accounts. Remove any partial journal at ${path} only after confirming deletion.`;
      throw new Error(`Cleanup failed or ownership check refused deletion. ${instruction} Provider details suppressed.`);
    }
  }

  try {
    if (recovery) {
      recoveryLockPath = `${path}.recovery.lock`;
      try {
        await journal.writeFile(
          recoveryLockPath,
          JSON.stringify({ pid: process.pid, token: randomUUID() }),
          { mode: 0o600, flag: "wx" },
        );
        recoveryLockAcquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Recovery already in progress or a prior recovery lock remains at ${recoveryLockPath}; no provider calls made and the journal at ${path} was retained. Retry only after verifying no recovery is running; do not remove the lock while one may be active.`);
        }
        throw new Error(`Could not acquire the recovery lock at ${recoveryLockPath}; no provider calls made and the journal at ${path} was retained.`);
      }
      let record: RecoveryRecord;
      try { record = parseRecoveryRecord(await journal.readFile(path, "utf8")); }
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
      throw new Error(`Account creation did not return an ID; its outcome is unknown. The private intent journal is ${path}. Explicitly recover it against the same Development instance with CLERK_PROVIDER_TESTS=isolated-development-only CLERK_PROVIDER_CLEANUP_MANIFEST=${JSON.stringify(path)} pnpm test:auth:provider. Recovery checks only exact generated email ${email} and private run marker ${runId}; it never creates another account. Do not retry creation until recovery confirms absence or deletes the verified fixture. Provider details suppressed.`);
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
