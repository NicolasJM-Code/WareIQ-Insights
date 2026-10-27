import { defineConfig } from "vitest/config";

// A separate explicit opt-in; ticket-cookie checks must not select this journey.
export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/api-server/browser-tests/hosted.test.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 180_000,
  },
});
