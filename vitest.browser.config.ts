import { defineConfig } from "vitest/config";

// Never included by the offline or bearer-provider configurations.
export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/api-server/browser-tests/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 240_000,
  },
});
