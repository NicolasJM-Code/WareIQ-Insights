import { defineConfig } from "vitest/config";
import { env } from "./vitest.config";

// Deliberately opt-in: starts a private PostgreSQL cluster, never a configured DB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/api-server/access-integration/**/*.test.ts"],
    env,
    hookTimeout: 30_000,
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
