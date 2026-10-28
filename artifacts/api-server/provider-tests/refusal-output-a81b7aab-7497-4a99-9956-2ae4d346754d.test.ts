
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
    