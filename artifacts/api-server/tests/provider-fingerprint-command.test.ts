import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createKeyPairAttestation, runKeyPairAttestationCheckCommand, runKeyPairFingerprintCommand,
} from "../provider-tests/harness";

const secretKey = "sk_test_fingerprint_command_secret";
const publishableKey = "pk_test_fingerprint_command_public";
const expectedFingerprintV1 = "3bb7582950684cbf789f55b440848b47d62cf88abf26dde138c4c5b317509fa2";
const fingerprint = createKeyPairAttestation(secretKey, publishableKey);
const tsx = createRequire(new URL("../../../scripts/package.json", import.meta.url)).resolve("tsx");
const attestationCheckPath = fileURLToPath(
  new URL("../provider-tests/key-pair-attestation-check.ts", import.meta.url),
);

describe("provider key-pair fingerprint command", () => {
  it("pins the v1 fingerprint algorithm to a fixed known-answer vector", () => {
    expect(createKeyPairAttestation(secretKey, publishableKey)).toBe(expectedFingerprintV1);
  });

  it("prints only the fingerprint for configured development keys", () => {
    let output = "";
    let error = "";
    const result = runKeyPairFingerprintCommand(
      { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: publishableKey },
      (text) => { output += text; },
      (text) => { error += text; },
    );

    expect(result).toBe(0);
    expect(error).toBe("");
    expect(output).toBe(`${expectedFingerprintV1}\n`);
    expect(output).not.toContain(secretKey);
    expect(output).not.toContain(publishableKey);
  });

  it.each([
    ["a missing secret key", { CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: publishableKey }],
    ["a missing publishable key", { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: "" }],
    ["a live secret key", { CLERK_SECRET_KEY: "sk_live_private", CLERK_PUBLISHABLE_KEY: publishableKey }],
    ["a live publishable key", { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: "pk_live_public" }],
  ])("refuses %s without printing keys or a fingerprint", (_case, env) => {
    let output = "";
    let error = "";
    const result = runKeyPairFingerprintCommand(
      env,
      (text) => { output += text; },
      (text) => { error += text; },
    );

    expect(result).toBe(1);
    expect(output).toBe("");
    expect(error).toContain("Cannot generate fingerprint");
    expect(error).not.toContain(secretKey);
    expect(error).not.toContain(publishableKey);
  });
});

describe("offline provider key-pair attestation check", () => {
  it("reports only a match or mismatch for configured development keys", () => {
    for (const [env, expectedStatus, expectedExitCode] of [
      [{
        CLERK_SECRET_KEY: secretKey,
        CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_PROVIDER_KEY_PAIR_ATTESTATION: fingerprint,
      }, "MATCH\n", 0],
      [{
        CLERK_SECRET_KEY: secretKey,
        CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_PROVIDER_KEY_PAIR_ATTESTATION: "0".repeat(64),
      }, "MISMATCH\n", 1],
      [{
        CLERK_SECRET_KEY: secretKey,
        CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_PROVIDER_KEY_PAIR_ATTESTATION: undefined,
      }, "MISMATCH\n", 1],
      [{
        CLERK_SECRET_KEY: secretKey,
        CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_PROVIDER_KEY_PAIR_ATTESTATION: "malformed",
      }, "MISMATCH\n", 1],
      [{
        CLERK_SECRET_KEY: "sk_live_private",
        CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_PROVIDER_KEY_PAIR_ATTESTATION: fingerprint,
      }, "MISMATCH\n", 1],
      [{
        CLERK_SECRET_KEY: secretKey,
        CLERK_PUBLISHABLE_KEY: "pk_live_public",
        CLERK_PROVIDER_KEY_PAIR_ATTESTATION: fingerprint,
      }, "MISMATCH\n", 1],
    ] as const) {
      let output = "";
      const result = runKeyPairAttestationCheckCommand(env, (text) => { output += text; });

      expect(result).toBe(expectedExitCode);
      expect(output).toBe(expectedStatus);
      expect(output).not.toContain(secretKey);
      expect(output).not.toContain(publishableKey);
      expect(output).not.toContain(fingerprint);
      if (env.CLERK_PROVIDER_KEY_PAIR_ATTESTATION) {
        expect(output).not.toContain(env.CLERK_PROVIDER_KEY_PAIR_ATTESTATION);
      }
    }
  });

  it("runs the CLI without network access or Clerk imports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wareiq-key-pair-check-"));
    try {
      const preloadPath = join(directory, "block-external-access.cjs");
      await writeFile(preloadPath, `
        const Module = require("node:module");
        const originalLoad = Module._load;
        Module._load = function (request, ...args) {
          if (request === "@clerk/express" || request.startsWith("@clerk/")) {
            throw new Error("FORBIDDEN_PROVIDER_IMPORT");
          }
          return Reflect.apply(originalLoad, this, [request, ...args]);
        };
        const net = require("node:net");
        const tls = require("node:tls");
        const http = require("node:http");
        const https = require("node:https");
        const forbidden = () => { throw new Error("FORBIDDEN_NETWORK_ACCESS"); };
        net.connect = forbidden;
        net.createConnection = forbidden;
        net.Socket.prototype.connect = forbidden;
        tls.connect = forbidden;
        http.request = forbidden;
        http.get = forbidden;
        https.request = forbidden;
        https.get = forbidden;
        globalThis.fetch = forbidden;
      `);
      const run = (attestation: string) => spawnSync(
        process.execPath,
        ["--import", tsx, attestationCheckPath],
        {
          encoding: "utf8",
          timeout: 15_000,
          env: {
            NODE_ENV: "test",
            NODE_OPTIONS: `--require=${preloadPath}`,
            CLERK_SECRET_KEY: secretKey,
            CLERK_PUBLISHABLE_KEY: publishableKey,
            CLERK_PROVIDER_KEY_PAIR_ATTESTATION: attestation,
          },
        },
      );

      const matching = run(fingerprint);
      expect(matching.error).toBeUndefined();
      expect(matching.status).toBe(0);
      expect(matching.stdout).toBe("MATCH\n");
      expect(matching.stderr).toBe("");

      const mismatching = run("0".repeat(64));
      expect(mismatching.error).toBeUndefined();
      expect(mismatching.status).toBe(1);
      expect(mismatching.stdout).toBe("MISMATCH\n");
      expect(mismatching.stderr).toBe("");
      for (const output of [matching.stdout, matching.stderr, mismatching.stdout, mismatching.stderr]) {
        expect(output).not.toContain(secretKey);
        expect(output).not.toContain(publishableKey);
        expect(output).not.toContain(fingerprint);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
