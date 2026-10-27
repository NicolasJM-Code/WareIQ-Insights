import { defineConfig } from "vitest/config";
import { env } from "./vitest.config";

// Opt-in database regressions use an isolated private PostgreSQL cluster.
export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/api-server/access-notifications-integration/**/*.test.ts"],
    env,
    hookTimeout: 30_000,
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
