import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Manifest = { userId: string; runId: string; email: string };
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
  deleteUser(id: string): Promise<unknown>;
};
export const journalIO = { mkdir, readFile, unlink, writeFile };
type Dependencies = {
  users: ProviderUsers;
  journal?: typeof journalIO;
  journalDirectory?: string;
  info?: (message: string) => void;
};

// Explicit input makes offline refusal tests independent of workspace secrets.
export function preflight(env: NodeJS.ProcessEnv) {
  if (env.CLERK_PROVIDER_TESTS !== "isolated-development-only"
    || env.NODE_ENV === "production"
    || !env.CLERK_SECRET_KEY?.startsWith("sk_test_")
    || !env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error("Provider checks require explicit opt-in and development-only Clerk keys. See docs/authorization-regression-tests.md.");
  }
}

// Provider exceptions can contain tokens; never expose their details or cause.
export async function provider<T>(label: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error(`Clerk development check failed during ${label}; provider details suppressed.`); }
}

function parseManifest(text: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Invalid manifest");
  const { userId, runId, email } = value as Partial<Manifest>;
  if (typeof userId !== "string" || !userId
    || typeof runId !== "string" || !/^[a-f0-9-]+$/.test(runId)
    || email !== `wareiq-provider-${runId}@example.com`) {
    throw new Error("Invalid manifest");
  }
  return { userId, runId, email };
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
      if (user.id !== manifest.userId
        || user.privateMetadata.wareiqProviderTest !== manifest.runId
        || user.emailAddresses.length !== 1
        || user.emailAddresses[0].emailAddress !== manifest.email
        || !/^wareiq-provider-[a-f0-9-]+@example\.com$/.test(manifest.email)) {
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
    } catch {
      if (deleted) {
        throw new Error(`Cleanup incomplete: generated account was deleted, but journal removal failed. Confirm its absence in the same Development instance, then manually remove ${path}. Do not rerun recovery for an already-deleted account.`);
      }
      const instruction = journalWritten
        ? `Retain ${path}. Retry against the same Development instance with CLERK_PROVIDER_TESTS=isolated-development-only CLERK_PROVIDER_CLEANUP_MANIFEST=${JSON.stringify(path)} pnpm test:auth:provider. If ownership differs, do not alter the journal or delete the account. If already absent, confirm absence before manually removing the journal.`
        : `No reliable recovery journal was saved. In the same Development instance, locate only generated user ${target.userId}, email ${target.email}, private run marker ${target.runId}; verify all three before manual deletion. Do not run journal recovery or bulk-delete accounts. Remove any partial journal at ${path} only after confirming deletion.`;
      throw new Error(`Cleanup failed or ownership check refused deletion. ${instruction} Provider details suppressed.`);
    }
  }

  try {
    if (recovery) {
      try { manifest = parseManifest(await journal.readFile(path, "utf8")); }
      catch {
        throw new Error("Recovery journal is unreadable or invalid; no provider calls made. Retain the journal and verify the original generated fixture in the same Development instance; do not retarget it.");
      }
      journalWritten = true;
      return; // finally cleans up; no account creation or access checks.
    }
    await journal.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const email = `wareiq-provider-${runId}@example.com`;
    let user: TestUser;
    try {
      user = await provider("disposable account creation", () => users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        publicMetadata: { role: "admin" },
        privateMetadata: { wareiqProviderTest: runId },
      }));
    } catch {
      throw new Error(`Account creation did not return an ID; its outcome is unknown. No recovery journal was saved. In the same Development instance, check exact generated email ${email} and private run marker ${runId} before any manual deletion. Do not retry creation until absence is confirmed. Provider details suppressed.`);
    }
    manifest = { userId: user.id, runId, email };
    try {
      await journal.writeFile(path, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
      journalWritten = true;
    } catch {
      throw new Error("Development check stopped: cleanup journal persistence failed; provider details suppressed.");
    }
    info(`Disposable account cleanup manifest: ${path}`);
    await check(manifest);
  } finally {
    await cleanup();
  }
}
