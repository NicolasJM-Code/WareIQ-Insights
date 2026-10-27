import { defineConfig } from "vitest/config";
import { env, wareiqResolve } from "./vitest.config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reportIsolationRegistry = mkdtempSync(join(tmpdir(), "wareiq-report-run-"));
process.env.WAREIQ_REPORT_TEST_REGISTRY = reportIsolationRegistry;

// Reuse the credential-free setup, not the preview server or its plugins.
// Keep these storage regressions out of the authorization-only command.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: wareiqResolve,
  test: {
    globalSetup: ["./vitest.reports.setup.ts"],
    projects: [
      {
        esbuild: { jsx: "automatic" },
        resolve: wareiqResolve,
        test: {
          name: "wareiq-reports",
          environment: "jsdom",
          include: ["artifacts/wareiq/tests/reports/**/*.test.ts"],
          env: { ...env, WAREIQ_REPORT_TEST_REGISTRY: reportIsolationRegistry },
        },
      },
      {
        test: {
          name: "api-reports",
          environment: "node",
          include: ["artifacts/api-server/tests/reports/**/*.test.ts"],
          env: { ...env, WAREIQ_REPORT_TEST_REGISTRY: reportIsolationRegistry },
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
