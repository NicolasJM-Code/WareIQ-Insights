const fixtureEnvironmentKeys = new Set([
  "WMS_MYSQL_TLS_RUNNER_CHECK",
  "WMS_MYSQL_TLS_INTEGRATION",
  "WMS_OPENVPN_MYSQL_TLS_INTEGRATION",
  "WMS_MYSQL_TLS_FIXTURE_DIR",
  "WMS_MYSQL_TLS_FIXTURE_PORT",
  "WMS_MYSQL_TLS_SECOND_FIXTURE_PORT",
  "WMS_MYSQL_TLS_RENEWED_FIXTURE_PORT",
  "WMS_MYSQL_TLS_FIXTURE_VERSION",
]);

for (const key of Object.keys(process.env)) {
  if (key.startsWith("WMS_") && !fixtureEnvironmentKeys.has(key)) {
    delete process.env[key];
  }
}
