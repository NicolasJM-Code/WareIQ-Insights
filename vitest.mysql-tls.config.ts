import { defineConfig } from "vitest/config";
import { env as baseEnv } from "./vitest.config";

const fixtureEnv = {
  ...baseEnv,
  WMS_MYSQL_TLS_RUNNER_CHECK: "1",
  WMS_MYSQL_TLS_INTEGRATION: process.env.WMS_MYSQL_TLS_INTEGRATION ?? "",
  WMS_OPENVPN_MYSQL_TLS_INTEGRATION:
    process.env.WMS_OPENVPN_MYSQL_TLS_INTEGRATION ?? "",
  WMS_MYSQL_TLS_FIXTURE_DIR: process.env.WMS_MYSQL_TLS_FIXTURE_DIR ?? "",
  WMS_MYSQL_TLS_FIXTURE_PORT: process.env.WMS_MYSQL_TLS_FIXTURE_PORT ?? "",
  WMS_MYSQL_TLS_SECOND_FIXTURE_PORT:
    process.env.WMS_MYSQL_TLS_SECOND_FIXTURE_PORT ?? "",
  WMS_MYSQL_TLS_RENEWED_FIXTURE_PORT:
    process.env.WMS_MYSQL_TLS_RENEWED_FIXTURE_PORT ?? "",
  WMS_MYSQL_TLS_FIXTURE_VERSION:
    process.env.WMS_MYSQL_TLS_FIXTURE_VERSION ?? "",
};

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "artifacts/api-server/tests/mysql-tls/runner.test.ts",
      "artifacts/api-server/tests/wms-mysql.tls.integration.test.ts",
      "artifacts/api-server/tests/wms-openvpn-mysql.tls.integration.test.ts",
    ],
    env: fixtureEnv,
    setupFiles: ["./scripts/mysql-tls-worker-env.ts"],
  },
});
