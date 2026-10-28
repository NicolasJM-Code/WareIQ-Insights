import { defineConfig } from "vitest/config";
import renewal from "./vitest.browser-renewal.config";

// Longer live repeat-cycle check; never selected by routine/offline tests.
export default defineConfig({
  ...renewal,
  test: {
    ...renewal.test,
    env: { CLERK_BROWSER_SCENARIO: "renewal-repeat" },
    testTimeout: 600_000,
  },
});
