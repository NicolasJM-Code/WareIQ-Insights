import { defineConfig } from "vitest/config";
import browser from "./vitest.browser.config";

// Explicitly selected live two-tab scenario, never routine/offline discovery.
export default defineConfig({
  ...browser,
  test: {
    ...browser.test,
    env: { CLERK_BROWSER_SCENARIO: "renewal-multitab" },
    testTimeout: 660_000,
  },
});
