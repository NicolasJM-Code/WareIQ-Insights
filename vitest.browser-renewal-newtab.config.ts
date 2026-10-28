import { defineConfig } from "vitest/config";
import browser from "./vitest.browser.config";

// A longer, opt-in Development case; never routine/offline discovery.
export default defineConfig({
  ...browser,
  test: {
    ...browser.test,
    env: { CLERK_BROWSER_SCENARIO: "renewal-newtab" },
    testTimeout: 420_000,
  },
});
