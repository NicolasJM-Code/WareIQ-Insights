import { describe, expect, it } from "vitest";
import {
  createKeyPairAttestation, runKeyPairFingerprintCommand,
} from "../provider-tests/harness";

const secretKey = "sk_test_fingerprint_command_secret";
const publishableKey = "pk_test_fingerprint_command_public";
const expectedFingerprintV1 = "3bb7582950684cbf789f55b440848b47d62cf88abf26dde138c4c5b317509fa2";

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
