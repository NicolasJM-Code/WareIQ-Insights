import { defineConfig } from "vitest/config";
import browser from "./vitest.browser.config";

// Separately enabled live race check; never part of routine/offline discovery.
export default defineConfig({
  ...browser,
  test: {
    ...browser.test,
    env: { CLERK_BROWSER_SCENARIO: "late-access-signout" },
  },
});
