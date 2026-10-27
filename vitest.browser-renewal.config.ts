import { defineConfig } from "vitest/config";
import browser from "./vitest.browser.config";

// Explicitly separate live run; never discovered by the offline suite.
export default defineConfig({
  ...browser,
  test: {
    ...browser.test,
    include: ["artifacts/api-server/browser-tests/clerk.test.ts"],
    env: { CLERK_BROWSER_SCENARIO: "renewal" },
    testTimeout: 360_000,
  },
});
