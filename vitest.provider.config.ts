import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts: ordinary authorization tests remain offline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/api-server/provider-tests/**/*.test.ts"],
    setupFiles: ["./artifacts/api-server/provider-tests/isolate-database-env.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 180_000,
  },
});
