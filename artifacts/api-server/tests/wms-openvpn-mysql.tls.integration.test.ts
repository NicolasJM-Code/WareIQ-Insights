import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { WmsConnectionInput } from "@workspace/api-zod";
import { startOpenVpnFixture } from "./mysql-tls/openvpn-connector-fixture.mjs";
import { safeConnectionFailure, testConnection, executeApprovedMysqlReport } from "../src/lib/wms-connection";
import type { WmsSiteScope } from "../src/lib/wms-site-config";

const enabled = process.env.WMS_OPENVPN_MYSQL_TLS_INTEGRATION === "1";
const siteScope: WmsSiteScope = {
  siteId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
};
const input: WmsConnectionInput = {
  engine: "mysql",
  host: "mysql.fixture.test",
  port: 3306,
  database: "reporting",
  schema: "reporting",
  username: "fixture_reader",
  sslMode: "verify-full",
  queryTimeoutSec: 5,
  siteId: siteScope.siteId,
};
const mapping = {
  view: "fixture_scoped_view",
  clientColumn: "client_code",
  siteColumn: "site_code",
  columns: { id: "id", label: "label" },
};
const reportScope = { clientKey: "fixture-client", siteKey: "fixture-site" };
const connectorCaEnv = "WMS_FIXTURE_CONNECTOR_HTTPS_CA";
const sqlCaEnv = "WMS_FIXTURE_SQL_CA";

let trustedConnectorCa = "";
let trustedSqlCa = "";
let fixturePort = 0;
let connector: Awaited<ReturnType<typeof startOpenVpnFixture>> | undefined;

// The actual HTTPS request and TLS validation remain intact. Only DNS is
// replaced so the fixture hostname resolves to the local connector server.
vi.mock("../src/lib/wms-openvpn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/wms-openvpn")>();
  const transport = actual.createWmsOpenVpnTransport({
    resolveGateway: async (hostname) => {
      if (hostname !== "connector.fixture.test")
        throw new Error("Unexpected connector fixture hostname.");
      return "127.0.0.1";
    },
  });
  return {
    ...actual,
    checkOpenVpn: transport.checkOpenVpn,
    openVpnMysqlStream: transport.openVpnMysqlStream,
  };
});

beforeAll(async () => {
  if (!enabled) return;
  const fixtureDir = process.env.WMS_MYSQL_TLS_FIXTURE_DIR;
  const rawPort = Number(process.env.WMS_MYSQL_TLS_FIXTURE_PORT);
  if (!fixtureDir || !Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535)
    throw new Error("The disposable MySQL TLS fixture runner did not provide its connection details.");
  fixturePort = rawPort;
  const [connectorCa, sqlCa] = await Promise.all([
    readFile(`${fixtureDir}/connector-certs/ca.pem`, "utf8"),
    readFile(`${fixtureDir}/certs/ca.pem`, "utf8"),
  ]);
  trustedConnectorCa = connectorCa;
  trustedSqlCa = sqlCa;
  connector = await startOpenVpnFixture({
    certFile: `${fixtureDir}/connector-certs/server-cert.pem`,
    keyFile: `${fixtureDir}/connector-certs/server-key.pem`,
    mysqlPort: fixturePort,
  });
  vi.stubEnv("WMS_MYSQL_CONNECTION_PATH", "openvpn");
  vi.stubEnv("WMS_FIXTURE_OPENVPN_TOKEN", connector.token);
  vi.stubEnv("WMS_FIXTURE_SQL_PASSWORD", "disposable-reader-password");
  vi.stubEnv(connectorCaEnv, trustedConnectorCa);
  vi.stubEnv(sqlCaEnv, trustedSqlCa);
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([{
    ...siteScope,
    connectorUrl: `https://connector.fixture.test:${connector.port}`,
    tokenEnv: "WMS_FIXTURE_OPENVPN_TOKEN",
    caEnv: connectorCaEnv,
    passwordEnv: "WMS_FIXTURE_SQL_PASSWORD",
    sqlCaEnv,
    host: input.host,
    port: input.port,
    database: input.database,
    username: input.username,
  }]));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await connector?.close();
});

async function probe() {
  try {
    return await testConnection(input, { siteScope });
  } catch (error) {
    const safe = safeConnectionFailure(error);
    return { status: "error" as const, code: safe.code, message: safe.message, testedAt: new Date().toISOString() };
  }
}

function report() {
  return executeApprovedMysqlReport(mapping, reportScope, undefined, { siteScope });
}

test.skipIf(!enabled)("the real HTTPS CONNECT and SQL TLS trust chains serve probes and mapped reports", async () => {
  expect(await probe()).toMatchObject({ status: "connected", code: "CONNECTED" });
  expect(await report()).toMatchObject({
    rows: [{ id: 1, label: "disposable fixture row" }],
    truncated: false,
  });
}, 30000);

test.skipIf(!enabled)("probes and reports reject connector HTTPS and SQL CAs used in the wrong role", async () => {
  // Wrong HTTPS trust stops both operations before the connector can create a
  // tunnel. Keep SQL trust valid to isolate the connector certificate check.
  vi.stubEnv(connectorCaEnv, trustedSqlCa);
  expect(await probe()).toMatchObject({ status: "error", code: "VPN_NOT_READY" });
  await expect(report().catch((error) => { throw safeConnectionFailure(error); }))
    .rejects.toMatchObject({ code: "VPN_NOT_READY" });

  // Restore HTTPS trust and use its CA for SQL. This reaches MySQL through
  // CONNECT, where mysql2 must reject the SQL server's independently signed TLS.
  vi.stubEnv(connectorCaEnv, trustedConnectorCa);
  vi.stubEnv(sqlCaEnv, trustedConnectorCa);
  expect(await probe()).toMatchObject({ status: "error", code: "TLS_FAILED" });
  await expect(report().catch((error) => { throw safeConnectionFailure(error); }))
    .rejects.toMatchObject({ code: "TLS_FAILED" });

  // Exchange the references in both directions. HTTPS fails first, proving
  // that the connector cannot borrow the private SQL CA as its trust root.
  vi.stubEnv(connectorCaEnv, trustedSqlCa);
  vi.stubEnv(sqlCaEnv, trustedConnectorCa);
  expect(await probe()).toMatchObject({ status: "error", code: "VPN_NOT_READY" });
  await expect(report().catch((error) => { throw safeConnectionFailure(error); }))
    .rejects.toMatchObject({ code: "VPN_NOT_READY" });
}, 30000);
