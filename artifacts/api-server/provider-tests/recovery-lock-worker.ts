import { access, writeFile } from "node:fs/promises";
import { createKeyPairAttestation, runProviderCheck, type ProviderUsers } from "./harness";

const [role, journalPath, directory, resultPath, pausedPath, releasePath] = process.argv.slice(2);
if (!["holder", "contender"].includes(role ?? "")
  || !journalPath || !directory || !resultPath || !pausedPath || !releasePath) {
  throw new Error("Recovery lock worker received invalid arguments.");
}

const secretKey = "sk_test_offline_fake";
const publishableKey = "pk_test_offline_fake";
const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const fixture = {
  id: "user_offline_fixture",
  privateMetadata: { wareiqProviderTest: runId },
  emailAddresses: [{ emailAddress: `wareiq-provider-${runId}@example.com` }],
};

async function recordProviderAccess() {
  await writeFile(`${directory}/${role}-provider-called`, "called", { flag: "wx" });
}

async function waitForRelease() {
  await writeFile(pausedPath, "paused");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(releasePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for the test to release the paused fake provider.");
}

const users: ProviderUsers = {
  async createUser() {
    await recordProviderAccess();
    return fixture;
  },
  async getUser() {
    await recordProviderAccess();
    if (role === "holder") await waitForRelease();
    return fixture;
  },
  async getUserList() {
    await recordProviderAccess();
    return { data: [fixture], totalCount: 1 };
  },
  async deleteUser() {
    await recordProviderAccess();
    throw new Error("Synthetic provider outage; keep the recovery journal.");
  },
};

const env = {
  NODE_ENV: "test",
  CLERK_PROVIDER_TESTS: "isolated-development-only",
  CLERK_SECRET_KEY: secretKey,
  CLERK_PUBLISHABLE_KEY: publishableKey,
  CLERK_PROVIDER_KEY_PAIR_ATTESTATION: createKeyPairAttestation(secretKey, publishableKey),
  CLERK_PROVIDER_CLEANUP_MANIFEST: journalPath,
};

try {
  await runProviderCheck(env, { users, journalDirectory: directory }, async () => {});
  await writeFile(resultPath, JSON.stringify({ success: true }));
} catch (error) {
  await writeFile(resultPath, JSON.stringify({ error: String(error) }));
}
