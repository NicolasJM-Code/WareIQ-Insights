import { defineConfig } from "vitest/config";
import { env, wareiqResolve } from "./vitest.config";

// Reuse the credential-free setup, not the preview server or its plugins.
// Keep these storage regressions out of the authorization-only command.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: wareiqResolve,
  test: {
    projects: [
      {
        esbuild: { jsx: "automatic" },
        resolve: wareiqResolve,
        test: {
          name: "wareiq-reports",
          environment: "jsdom",
          include: ["artifacts/wareiq/tests/reports/**/*.test.ts"],
          env,
        },
      },
      {
        test: {
          name: "api-reports",
          environment: "node",
          include: ["artifacts/api-server/tests/reports/**/*.test.ts"],
          env,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
