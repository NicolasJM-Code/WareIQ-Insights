import { describe, expect, it } from "vitest";
import {
  createKeyPairAttestation, runKeyPairFingerprintCommand,
} from "../provider-tests/harness";

const secretKey = "sk_test_fingerprint_command_secret";
const publishableKey = "pk_test_fingerprint_command_public";

describe("provider key-pair fingerprint command", () => {
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
    expect(output).toBe(`${createKeyPairAttestation(secretKey, publishableKey)}\n`);
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
