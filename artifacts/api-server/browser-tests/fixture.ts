import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, basename, dirname } from "node:path";
import { clerkClient } from "@clerk/express";
import { assertKeyPairAttestation } from "../provider-tests/harness";

const directory = resolve(".cache/clerk-browser");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Manifest = { kind: "wareiq-browser"; runId: string; email: string; userId: string };
type Intent = { kind: "wareiq-browser"; state: "intent"; runId: string; email: string };
let manifest: Manifest | undefined;
let path: string;

function assertCurrentKeyPair() {
  const { CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_PROVIDER_KEY_PAIR_ATTESTATION } = process.env;
  if (!CLERK_SECRET_KEY || !CLERK_PUBLISHABLE_KEY) {
    throw new Error("Clerk browser checks refused: Development keys and their local pairing attestation are required.");
  }
  assertKeyPairAttestation(CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_PROVIDER_KEY_PAIR_ATTESTATION);
}

export function preflight(optIn = "CLERK_BROWSER_TESTS") {
  if (process.env[optIn] !== "isolated-development-only"
    || process.env.NODE_ENV === "production"
    || !process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")
    || !process.env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error("Browser checks require explicit opt-in and Development keys. See docs/authorization-regression-tests.md.");
  }
  assertCurrentKeyPair();
}

// Provider and Playwright errors can contain credentials. Do not attach causes,
// response bodies, screenshots, traces, browser console logs or storage state.
export async function safe<T>(label: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error(`Clerk browser check failed during ${label}; sensitive details suppressed.`); }
}

export async function createFixture(password?: string) {
  assertCurrentKeyPair();
  const runId = randomUUID();
  const email = `wareiq-browser-${runId}${password ? "+clerk_test" : ""}@example.com`;
  path = resolve(directory, `${runId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const intent: Intent = { kind: "wareiq-browser", state: "intent", runId, email };
  try {
    await writeFile(path, JSON.stringify(intent), { mode: 0o600, flag: "wx" });
  } catch {
    throw new Error("Browser check stopped: private creation intent could not be saved; no account was created.");
  }
  console.info(`Disposable browser account cleanup manifest: ${path}`);
  let user: Awaited<ReturnType<typeof clerkClient.users.createUser>>;
  try {
    user = await safe("disposable account creation", () => clerkClient.users.createUser({
      emailAddress: [email], ...(password ? { password } : { skipPasswordRequirement: true }),
      publicMetadata: { role: "admin" },
      privateMetadata: { wareiqBrowserTest: runId },
    }));
  } catch {
    // A timed-out provider call may have created the account. Do NOT delete
    // without an ID or retry creation; intent recovery checks exact ownership.
    throw new Error(`Account creation outcome is unknown. Retain ${path} and run explicit cleanup recovery against the same Development instance before retrying creation. Provider details suppressed.`);
  }
  manifest = { kind: "wareiq-browser", runId, email, userId: user.id };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    try { await unlink(temporary); } catch { /* Retain original intent. */ }
    throw new Error("Browser cleanup journal update failed; ID-scoped cleanup will be attempted.");
  }
  return user.id;
}

export async function createHostedFixture() {
  // Never accept an existing user's credentials. Password exists only in memory.
  const password = `Wiq!${randomUUID()}Aa9`;
  const userId = await createFixture(password);
  return { userId, email: manifest!.email, password };
}

export async function recoverFixture(filename: string) {
  assertCurrentKeyPair();
  path = resolve(filename);
  if (dirname(path) !== directory) throw new Error("Cleanup refused: journal must be in .cache/clerk-browser.");
  const candidate: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!candidate || typeof candidate !== "object") throw new Error("Invalid browser cleanup journal.");
  const m = candidate as Partial<Manifest & Intent>;
  if (m.kind !== "wareiq-browser" || typeof m.runId !== "string" || !uuid.test(m.runId)
    || basename(path) !== `${m.runId}.json`
    || ![`wareiq-browser-${m.runId}@example.com`,
      `wareiq-browser-${m.runId}+clerk_test@example.com`].includes(m.email ?? "")) {
    throw new Error("Cleanup refused: invalid generated-account journal.");
  }
  if (m.state === "intent" && m.userId === undefined) {
    const result = await safe("exact-email creation recovery", () =>
      clerkClient.users.getUserList({ emailAddress: [m.email!], limit: 2 }));
    if (!result || !Array.isArray(result.data) || !Number.isInteger(result.totalCount))
      throw new Error("Recovery refused: invalid exact-email provider response.");
    if (result.totalCount === 0 && result.data.length === 0) {
      await unlink(path);
      return;
    }
    if (result.totalCount !== 1 || result.data.length !== 1
      || result.data[0].privateMetadata.wareiqBrowserTest !== m.runId
      || result.data[0].emailAddresses.length !== 1
      || result.data[0].emailAddresses[0].emailAddress !== m.email)
      throw new Error("Recovery refused: exact email did not identify one generated account with the private marker.");
    manifest = { kind: "wareiq-browser", runId: m.runId!, email: m.email!, userId: result.data[0].id };
  } else if (m.state === undefined && typeof m.userId === "string" && /^user_[A-Za-z0-9]+$/.test(m.userId)) {
    manifest = m as Manifest;
  } else {
    throw new Error("Cleanup refused: invalid generated-account journal.");
  }
  await cleanupFixture();
}

export async function cleanupFixture() {
  if (!manifest) return;
  assertCurrentKeyPair();
  const m = manifest;
  const user = await safe("cleanup ownership verification", () => clerkClient.users.getUser(m.userId));
  if (user.id !== m.userId || user.privateMetadata.wareiqBrowserTest !== m.runId
    || user.emailAddresses.length !== 1 || user.emailAddresses[0].emailAddress !== m.email) {
    throw new Error("Cleanup refused: generated-account ownership mismatch.");
  }
  await safe("generated account deletion", () => clerkClient.users.deleteUser(m.userId));
  await unlink(path);
  manifest = undefined;
}
