import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createKeyPairAttestation } from "../provider-tests/harness";

const workspaceRoot = resolve(process.cwd());
const providerTestFile = "artifacts/api-server/provider-tests/clerk.test.ts";
const manifest = {
  userId: "user_offline_provider_fixture",
  runId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  email: "wareiq-provider-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa@example.com",
};

describe("opt-in provider test boundary", () => {
  it("keeps live tests out of routine discovery and gates the live entrypoint", async () => {
    const packageJson = JSON.parse(
      await readFile(join(workspaceRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const scripts = packageJson.scripts;
    expect(scripts["test:auth"]).toBe("vitest run --config vitest.config.ts");
    expect(scripts["test:auth:provider"])
      .toBe("vitest run --config vitest.provider.config.ts");
    expect(scripts["test:auth"]).not.toContain("test:auth:provider");
    expect(scripts["test:auth:typecheck"]).not.toContain("test:auth:provider");

    const offlineConfig = await readFile(join(workspaceRoot, "vitest.config.ts"), "utf8");
    const offlineIncludes = getIncludePatterns(offlineConfig);
    expect(offlineIncludes).toContain("artifacts/api-server/tests/**/*.test.ts");
    expect(offlineIncludes.some((pattern) => matchesGlob(providerTestFile, pattern))).toBe(false);

    const providerConfig = await readFile(
      join(workspaceRoot, "vitest.provider.config.ts"),
      "utf8",
    );
    expect(getIncludePatterns(providerConfig))
      .toEqual(["artifacts/api-server/provider-tests/**/*.test.ts"]);

    await expectOfflineAuthorizationDatabaseIsolation();
    await expectProviderDatabaseIsolation();
    await expectLiveEntrypointToRespectPreflightAndRecovery();
  }, 120_000);
});

function getIncludePatterns(configSource: string) {
  return [...configSource.matchAll(/\binclude:\s*(\[[^\]]*\])/g)]
    .flatMap(([, raw]) => JSON.parse(raw) as string[]);
}

async function expectOfflineAuthorizationDatabaseIsolation() {
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "wareiq-offline-auth-database-"));
  const probeName = `offline-database-boundary-probe-${directory.split("/").at(-1)}.test.ts`;
  const probePath = join(workspaceRoot, "artifacts/api-server/tests", probeName);
  const wareiqProbeName = `offline-database-boundary-probe-${directory.split("/").at(-1)}.test.tsx`;
  const wareiqProbePath = join(workspaceRoot, "artifacts/wareiq/tests", wareiqProbeName);
  const configPath = join(directory, "vitest.config.mjs");
  const setupPath = join(directory, "observe-database-clients.ts");
  const networkBlockerPath = join(directory, "block-network.cjs");
  const clientLogPath = join(directory, "database-clients.jsonl");

  try {
    await writeFile(
      probePath,
      `
import { expect, it } from "vitest";

it("clears synthetic application and WMS database settings in auth workers", () => {
  expect(process.env.DATABASE_URL).toBe("");
  expect(process.env.WMS_DATABASE_URL).toBe("");
  expect(process.env.WMS_PGPASSWORD).toBe("");
});
`,
    );
    await writeFile(
      wareiqProbePath,
      `
import { expect, it } from "vitest";

it("clears synthetic application and WMS database settings in WareIQ workers", () => {
  expect(process.env.DATABASE_URL).toBe("");
  expect(process.env.WMS_DATABASE_URL).toBe("");
  expect(process.env.WMS_PGPASSWORD).toBe("");
});
`,
    );
    await writeFile(
      setupPath,
      `
import { appendFileSync } from "node:fs";
import { vi } from "vitest";

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal();
  class ObservedPool extends actual.Pool {
    constructor(...args) {
      appendFileSync(process.env.WAREIQ_OFFLINE_DATABASE_CLIENT_LOG, "Pool\\\\n");
      super(...args);
    }
  }
  class ObservedClient extends actual.Client {
    constructor(...args) {
      appendFileSync(process.env.WAREIQ_OFFLINE_DATABASE_CLIENT_LOG, "Client\\\\n");
      super(...args);
    }
  }
  return {
    ...actual,
    Pool: ObservedPool,
    Client: ObservedClient,
    default: { ...actual.default, Pool: ObservedPool, Client: ObservedClient },
  };
});
`,
    );
    await writeFile(networkBlockerPath, networkBlockerModule);
    await writeFile(
      configPath,
      `
import baseConfig from ${JSON.stringify(join(workspaceRoot, "vitest.config.ts"))};

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: baseConfig.test.projects.map((project) => {
      return {
        ...project,
        test: {
          ...project.test,
          setupFiles: [${JSON.stringify(setupPath)}],
          ...(project.test.name === "api-authorization"
            ? {
                exclude: [
                  ...(project.test.exclude ?? []),
                  "artifacts/api-server/tests/provider-boundary.test.ts",
                ],
              }
            : {}),
        },
      };
    }),
  },
};
`,
    );

    const result = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        configPath,
        "--root",
        workspaceRoot,
      ],
      {
        cwd: workspaceRoot,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
          NODE_OPTIONS: `--require=${networkBlockerPath}`,
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/application",
          WMS_DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/wms",
          WMS_PGPASSWORD: "synthetic-offline-password",
          WAREIQ_OFFLINE_DATABASE_CLIENT_LOG: clientLogPath,
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain(probeName);
    expect(output).toContain(wareiqProbeName);
    expect(output).not.toContain("FORBIDDEN_OFFLINE_NETWORK");
    expect(existsSync(clientLogPath)).toBe(false);
  } finally {
    await rm(probePath, { force: true });
    await rm(wareiqProbePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectProviderDatabaseIsolation() {
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "wareiq-provider-database-"));
  const networkBlockerPath = join(directory, "block-network.cjs");

  try {
    await writeFile(networkBlockerPath, networkBlockerModule);
    const result = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        join(workspaceRoot, "vitest.provider.config.ts"),
        "--root",
        workspaceRoot,
        "--reporter=verbose",
        "--testNamePattern",
        "keeps provider execution isolated from application and WMS databases",
      ],
      {
        cwd: workspaceRoot,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
          NODE_OPTIONS: `--require=${networkBlockerPath}`,
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/application",
          WMS_DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/wms",
          WMS_PGPASSWORD: "synthetic-offline-password",
        },
        encoding: "utf8",
        timeout: 45_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain(
      "keeps provider execution isolated from application and WMS databases",
    );
    expect(output).not.toContain("FORBIDDEN_OFFLINE_NETWORK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it.each(["vitest.browser.config.ts", "vitest.browser-renewal-multitab.config.ts"])(
  "keeps browser execution isolated from application and WMS databases with %s", async config => {
  await expectBrowserDatabaseIsolation(config);
}, 60_000);

async function expectBrowserDatabaseIsolation(config: string) {
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "wareiq-browser-database-"));
  const networkBlockerPath = join(directory, "block-network.cjs");

  try {
    await writeFile(networkBlockerPath, networkBlockerModule);
    const result = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        join(workspaceRoot, config),
        "--root",
        workspaceRoot,
        "--reporter=verbose",
        "--testNamePattern",
        "keeps browser execution isolated from application and WMS databases",
      ],
      {
        cwd: workspaceRoot,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
          NODE_OPTIONS: `--require=${networkBlockerPath}`,
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/application",
          WMS_DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/wms",
          WMS_PGPASSWORD: "synthetic-offline-password",
        },
        encoding: "utf8",
        timeout: 45_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain(
      "keeps browser execution isolated from application and WMS databases",
    );
    expect(output).not.toContain("FORBIDDEN_OFFLINE_NETWORK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectLiveEntrypointToRespectPreflightAndRecovery() {
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "wareiq-provider-boundary-"));
  const configPath = join(directory, "vitest.config.ts");
  const fakeClerkPath = join(directory, "fake-clerk.ts");
  const blockedAppPath = join(directory, "blocked-app.ts");
  const networkBlockerPath = join(directory, "block-network.cjs");
  const callLogPath = join(directory, "fake-clerk-calls.jsonl");
  const journalPath = join(directory, "recovery.json");

  try {
    await writeFile(journalPath, JSON.stringify(manifest), { mode: 0o600 });
    await writeFile(fakeClerkPath, fakeClerkModule);
    await writeFile(blockedAppPath, blockedAppModule);
    await writeFile(networkBlockerPath, networkBlockerModule);
    await writeFile(configPath, isolatedVitestConfig);

    const preflight = runLiveEntrypoint(directory, configPath, callLogPath, {
      NODE_ENV: "production",
      CLERK_PROVIDER_TESTS: "isolated-development-only",
      CLERK_SECRET_KEY: "sk_test_offline_fake",
      CLERK_PUBLISHABLE_KEY: "pk_test_offline_fake",
      CLERK_PROVIDER_KEY_PAIR_ATTESTATION: createKeyPairAttestation(
        "sk_test_offline_fake", "pk_test_offline_fake",
      ),
      CLERK_PROVIDER_CLEANUP_MANIFEST: journalPath,
    });
    expect(preflight.error).toBeUndefined();
    expect(preflight.status).not.toBe(0);
    expect(`${preflight.stdout ?? ""}\n${preflight.stderr ?? ""}`)
      .toContain("Provider checks require explicit opt-in and development-only Clerk keys");
    expect(`${preflight.stdout ?? ""}\n${preflight.stderr ?? ""}`)
      .not.toContain("FORBIDDEN_PROVIDER_APP_IMPORT");
    expect(`${preflight.stdout ?? ""}\n${preflight.stderr ?? ""}`)
      .not.toContain("FORBIDDEN_OFFLINE_NETWORK");
    expect(existsSync(callLogPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(true);

    const staleAttestation = runLiveEntrypoint(directory, configPath, callLogPath, {
      NODE_ENV: "test",
      CLERK_PROVIDER_TESTS: "isolated-development-only",
      CLERK_SECRET_KEY: "sk_test_offline_other",
      CLERK_PUBLISHABLE_KEY: "pk_test_offline_fake",
      CLERK_PROVIDER_KEY_PAIR_ATTESTATION: createKeyPairAttestation(
        "sk_test_offline_fake", "pk_test_offline_fake",
      ),
      CLERK_PROVIDER_CLEANUP_MANIFEST: journalPath,
    });
    expect(staleAttestation.error).toBeUndefined();
    expect(staleAttestation.status).not.toBe(0);
    expect(`${staleAttestation.stdout ?? ""}\n${staleAttestation.stderr ?? ""}`)
      .toContain("local pairing attestation");
    expect(`${staleAttestation.stdout ?? ""}\n${staleAttestation.stderr ?? ""}`)
      .not.toContain("FORBIDDEN_PROVIDER_APP_IMPORT");
    expect(`${staleAttestation.stdout ?? ""}\n${staleAttestation.stderr ?? ""}`)
      .not.toContain("FORBIDDEN_OFFLINE_NETWORK");
    expect(existsSync(callLogPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(true);

    const recovery = runLiveEntrypoint(directory, configPath, callLogPath, {
      NODE_ENV: "test",
      CLERK_PROVIDER_TESTS: "isolated-development-only",
      CLERK_SECRET_KEY: "sk_test_offline_fake",
      CLERK_PUBLISHABLE_KEY: "pk_test_offline_fake",
      CLERK_PROVIDER_KEY_PAIR_ATTESTATION: createKeyPairAttestation(
        "sk_test_offline_fake", "pk_test_offline_fake",
      ),
      CLERK_PROVIDER_CLEANUP_MANIFEST: journalPath,
    });
    expect(recovery.error).toBeUndefined();
    expect(recovery.status, `${recovery.stdout ?? ""}\n${recovery.stderr ?? ""}`).toBe(0);
    expect(`${recovery.stdout ?? ""}\n${recovery.stderr ?? ""}`)
      .not.toContain("FORBIDDEN_OFFLINE_NETWORK");
    expect(existsSync(journalPath)).toBe(false);
    expect(await readFile(callLogPath, "utf8")).toEqual([
      { method: "users.getUser", id: manifest.userId },
      { method: "users.deleteUser", id: manifest.userId },
    ].map((call) => JSON.stringify(call)).join("\n") + "\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runLiveEntrypoint(
  directory: string,
  configPath: string,
  callLogPath: string,
  scenarioEnv: NodeJS.ProcessEnv,
) {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: directory,
    TMPDIR: directory,
    NODE_OPTIONS: `--require=${join(directory, "block-network.cjs")}`,
    ...scenarioEnv,
    WAREIQ_PROVIDER_CALL_LOG: callLogPath,
    WAREIQ_PROVIDER_FAKE_USER_ID: manifest.userId,
    WAREIQ_PROVIDER_FAKE_RUN_ID: manifest.runId,
    WAREIQ_PROVIDER_FAKE_EMAIL: manifest.email,
  };
  return spawnSync(
    process.execPath,
    [
      join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      configPath,
      "--root",
      workspaceRoot,
    ],
    {
      cwd: workspaceRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 45_000,
    },
  );
}

const isolatedVitestConfig = `
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{
    name: "block-provider-test-application-imports",
    enforce: "pre",
    resolveId(source) {
      if (source === "../src/app" || source === "../src/routes") {
        return fileURLToPath(new URL("./blocked-app.ts", import.meta.url));
      }
      return null;
    },
  }],
  resolve: {
    alias: [{
      find: "@clerk/express",
      replacement: fileURLToPath(new URL("./fake-clerk.ts", import.meta.url)),
    }],
  },
  test: {
    environment: "node",
    include: ["${providerTestFile}"],
    fileParallelism: false,
  },
});
`;

const blockedAppModule = `
throw new Error("FORBIDDEN_PROVIDER_APP_IMPORT");
export default {};
`;

const networkBlockerModule = `
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const forbidden = () => { throw new Error("FORBIDDEN_OFFLINE_NETWORK"); };
const isAllowedLocalTestServer = (args) => {
  const parameters = Array.isArray(args[0]) ? args[0] : args;
  const options = parameters[0];
  const host = typeof options === "object" && options !== null
    ? options.host ?? options.hostname
    : typeof parameters[1] === "string" ? parameters[1] : undefined;
  const port = typeof options === "object" && options !== null
    ? options.port
    : typeof options === "number" ? options : undefined;
  return ["localhost", "127.0.0.1", "::1"].includes(host) &&
    Number(port) !== 1;
};
const blockUnlessLocalTestServer = (original) => function (...args) {
  if (!isAllowedLocalTestServer(args)) return forbidden();
  return Reflect.apply(original, this, args);
};
net.connect = blockUnlessLocalTestServer(net.connect);
net.createConnection = blockUnlessLocalTestServer(net.createConnection);
net.Socket.prototype.connect = blockUnlessLocalTestServer(net.Socket.prototype.connect);
tls.connect = forbidden;
http.request = blockUnlessLocalTestServer(http.request);
http.get = blockUnlessLocalTestServer(http.get);
https.request = forbidden;
https.get = forbidden;
globalThis.fetch = forbidden;
`;

const fakeClerkModule = `
import { appendFileSync } from "node:fs";

function record(method: string, id?: string) {
  appendFileSync(process.env.WAREIQ_PROVIDER_CALL_LOG!, JSON.stringify({ method, ...(id ? { id } : {}) }) + "\\n");
}

const user = {
  id: process.env.WAREIQ_PROVIDER_FAKE_USER_ID!,
  privateMetadata: { wareiqProviderTest: process.env.WAREIQ_PROVIDER_FAKE_RUN_ID! },
  emailAddresses: [{ emailAddress: process.env.WAREIQ_PROVIDER_FAKE_EMAIL! }],
};

export const clerkClient = {
  users: {
    createUser: async () => { record("users.createUser"); throw new Error("fake provider call"); },
    getUser: async (id: string) => { record("users.getUser", id); return user; },
    deleteUser: async (id: string) => { record("users.deleteUser", id); },
  },
  sessions: {
    createSession: async () => { record("sessions.createSession"); throw new Error("fake provider call"); },
    getToken: async () => { record("sessions.getToken"); throw new Error("fake provider call"); },
    revokeSession: async () => { record("sessions.revokeSession"); throw new Error("fake provider call"); },
  },
};

export const clerkMiddleware = () => { throw new Error("fake Clerk middleware"); };
export const getAuth = () => { throw new Error("fake Clerk auth"); };
`;
