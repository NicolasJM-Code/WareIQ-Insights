import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Deliberately independent of Vite's preview plugins and all live credentials.
export const env = {
  NODE_ENV: "test",
  CLERK_SECRET_KEY: "",
  CLERK_PUBLISHABLE_KEY: "",
  VITE_CLERK_PUBLISHABLE_KEY: "",
  CLERK_WEBHOOK_SIGNING_SECRET: "",
  CLERK_WEBHOOK_ENVIRONMENT: "",
  CLERK_WEBHOOK_INSTANCE_ID: "",
  WMS_DATABASE_URL: "",
  WMS_PGPASSWORD: "",
  WMS_MYSQL_CONNECTION_PATH: "direct",
  WMS_OPENVPN_CONNECTOR_URL: "",
  WMS_OPENVPN_CONNECTOR_TOKEN: "",
  DATABASE_URL: "",
};

export const wareiqResolve = {
  alias: {
    "@assets": fileURLToPath(new URL("./attached_assets", import.meta.url)),
    "@": fileURLToPath(new URL("./artifacts/wareiq/src", import.meta.url)),
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api-authorization",
          environment: "node",
          include: ["artifacts/api-server/tests/**/*.test.ts", "scripts/src/**/*.test.ts"],
          exclude: ["artifacts/api-server/tests/reports/**"],
          env,
        },
      },
      {
        esbuild: { jsx: "automatic" },
        resolve: wareiqResolve,
        test: {
          name: "wareiq-authorization",
          environment: "jsdom",
          include: ["artifacts/wareiq/tests/**/*.test.tsx"],
          env,
        },
      },
    ],
  },
});
