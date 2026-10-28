import { createConnection, createServer, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import type { WmsConnectionInput, WmsConnectionResult } from "@workspace/api-zod";
import { safeConnectionFailure, testConnection, executeApprovedMysqlReport } from "../src/lib/wms-connection";
import { testMysqlConnection } from "../src/lib/wms-mysql-connection";

// Only replace the HTTPS transport. Real mysql2 TLS runs over a disposable
// loopback stream, just as it does over the connector's opaque byte tunnel.
vi.mock("../src/lib/wms-openvpn", () => ({
  mysqlConnectionPath: () => "openvpn",
  openVpnMysqlStream: async (target: { port: number }) =>
    createConnection({ host: "127.0.0.1", port: target.port }),
  checkOpenVpn: vi.fn(),
}));

const enabled = process.env.WMS_MYSQL_TLS_INTEGRATION === "1";
const input: WmsConnectionInput = {
  engine: "mysql",
  host: "mysql.fixture.test",
  port: 3306,
  database: "reporting",
  schema: "reporting",
  username: "fixture_reader",
  sslMode: "verify-full",
  queryTimeoutSec: 1,
};
const fixturePasswords = {
  reader: "disposable-reader-password",
  writer: "disposable-writer-password",
  role: "disposable-role-password",
  empty: "disposable-empty-password",
};

const fixtureAddress = "127.0.0.1";
let fixturePort = 0;
let secondFixturePort = 0;
let renewedFixturePort = 0;
let trustedCa = "";
let secondCa = "";
let renewedCa = "";

beforeAll(async () => {
  if (!enabled) return;
  const fixtureDir = process.env.WMS_MYSQL_TLS_FIXTURE_DIR;
  const port = Number(process.env.WMS_MYSQL_TLS_FIXTURE_PORT);
  const secondPort = Number(process.env.WMS_MYSQL_TLS_SECOND_FIXTURE_PORT);
  const renewedPort = Number(process.env.WMS_MYSQL_TLS_RENEWED_FIXTURE_PORT);
  if (!fixtureDir || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(secondPort) || secondPort < 1 || secondPort > 65535 ||
      !Number.isInteger(renewedPort) || renewedPort < 1 || renewedPort > 65535) {
    throw new Error("The disposable MySQL TLS fixture runner did not provide its connection details.");
  }
  fixturePort = port;
  secondFixturePort = secondPort;
  renewedFixturePort = renewedPort;
  trustedCa = await readFile(`${fixtureDir}/certs/ca.pem`, "utf8");
  secondCa = await readFile(`${fixtureDir}/certs-second/ca.pem`, "utf8");
  renewedCa = await readFile(`${fixtureDir}/certs-renewed/ca.pem`, "utf8");
  vi.stubEnv("WMS_MYSQL_CA_CERT", trustedCa);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function probe(
  overrides: Partial<WmsConnectionInput> = {},
  password = fixturePasswords.reader,
  address = fixtureAddress,
  port = fixturePort,
): Promise<WmsConnectionResult> {
  try {
    return await testMysqlConnection({ ...input, port, ...overrides }, password, address);
  } catch (error) {
    const safe = safeConnectionFailure(error);
    return {
      status: "error",
      code: safe.code,
      message: safe.message,
      testedAt: new Date().toISOString(),
    };
  }
}

test.skipIf(!enabled)("trusted CA, hostname and read-only view access succeed", async () => {
  const result = await probe();
  expect(result.status).toBe("connected");
  expect(result.code).toBe("CONNECTED");
});

test.skipIf(!enabled)("untrusted CA and hostname mismatch fail verified TLS", async () => {
  const badCa = await readFile(
    `${process.env.WMS_MYSQL_TLS_FIXTURE_DIR}/certs/untrusted-ca.pem`,
    "utf8",
  ).catch(() => undefined);
  expect(badCa, "test runner must generate an unrelated CA").toBeDefined();
  vi.stubEnv("WMS_MYSQL_CA_CERT", badCa!);
  expect((await probe()).code).toBe("TLS_FAILED");

  vi.stubEnv("WMS_MYSQL_CA_CERT", trustedCa);
  expect((await probe({ host: "wrong.fixture.test" })).code).toBe("TLS_FAILED");
});

test.skipIf(!enabled)("authentication failure is rejected by the real fixture server", async () => {
  expect((await probe({}, "incorrect-disposable-password")).code).toBe("AUTHENTICATION_FAILED");
});

test.skipIf(!enabled)("write grants and active roles are rejected", async () => {
  expect((await probe({ username: "fixture_writer" }, fixturePasswords.writer)).code)
    .toBe("READ_ONLY_ROLE_REQUIRED");
  expect((await probe({ username: "fixture_role_reader" }, fixturePasswords.role)).code)
    .toBe("READ_ONLY_ROLE_REQUIRED");
});

test.skipIf(!enabled)("a schema without reporting views is rejected", async () => {
  expect((await probe({
    database: "reporting_empty",
    schema: "reporting_empty",
    username: "fixture_empty_reader",
  }, fixturePasswords.empty)).code).toBe("REPORTING_VIEWS_REQUIRED");
});

test.skipIf(!enabled)("two warehouses trust only their own private SQL CA for probes and reports", async () => {
  const first = {
    siteId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
    connectorUrl: "https://first.fixture.test", tokenEnv: "WMS_FIXTURE_FIRST_TOKEN",
    passwordEnv: "WMS_FIXTURE_SQL_PASSWORD", sqlCaEnv: "WMS_FIXTURE_FIRST_SQL_CA",
    host: input.host, port: fixturePort, database: input.database, username: input.username,
  };
  const second = { ...first, siteId: "33333333-3333-4333-8333-333333333333",
    connectorUrl: "https://second.fixture.test", tokenEnv: "WMS_FIXTURE_SECOND_TOKEN",
    sqlCaEnv: "WMS_FIXTURE_SECOND_SQL_CA", port: secondFixturePort };
  vi.stubEnv(first.tokenEnv, "first-disposable-site-token-".repeat(3));
  vi.stubEnv(second.tokenEnv, "second-disposable-site-token-".repeat(3));
  vi.stubEnv(first.passwordEnv, fixturePasswords.reader);
  vi.stubEnv(first.sqlCaEnv, trustedCa);
  vi.stubEnv(second.sqlCaEnv, secondCa);
  // A shared bundle that trusts both peers must not widen either site's trust.
  vi.stubEnv("WMS_MYSQL_CA_CERT", `${trustedCa}\n${secondCa}`);
  const mapping = { view: "fixture_scoped_view", clientColumn: "client_code",
    siteColumn: "site_code", columns: { id: "id", label: "label" } };
  const reportScope = { clientKey: "fixture-client", siteKey: "fixture-site" };
  const setSites = () => vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([first, second]));
  const probeSite = (site: typeof first) => testConnection(
    { ...input, siteId: site.siteId, host: site.host, port: site.port }, { siteScope: site });
  const reportSite = (site: typeof first) => executeApprovedMysqlReport(
    mapping, reportScope, undefined, { siteScope: site });
  try {
    setSites();
    for (const site of [first, second]) {
      expect(await probeSite(site)).toMatchObject({ status: "connected", code: "CONNECTED" });
      expect(await reportSite(site)).toMatchObject({
        rows: [{ id: 1, label: "disposable fixture row" }], truncated: false,
      });
    }
    // Exchange only the CAs: both databases keep the same valid DNS identity.
    vi.stubEnv(first.sqlCaEnv, secondCa);
    vi.stubEnv(second.sqlCaEnv, trustedCa);
    for (const site of [first, second]) {
      expect(await probeSite(site)).toMatchObject({ status: "error", code: "TLS_FAILED" });
      await expect(reportSite(site).catch((error) => { throw safeConnectionFailure(error); }))
        .rejects.toMatchObject({ code: "TLS_FAILED" });
    }
    // No per-site CA means system roots, not the shared bundle trusting both.
    vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([first, second].map(({ sqlCaEnv: _ca, ...site }) => site)));
    for (const site of [first, second]) {
      expect(await probeSite(site)).toMatchObject({ status: "error", code: "TLS_FAILED" });
      await expect(reportSite(site).catch((error) => { throw safeConnectionFailure(error); }))
        .rejects.toMatchObject({ code: "TLS_FAILED" });
    }
    vi.stubEnv(first.sqlCaEnv, trustedCa);
    vi.stubEnv(second.sqlCaEnv, secondCa);
    for (const site of [first, second]) {
      site.host = "wrong.fixture.test";
      setSites();
      expect(await probeSite(site)).toMatchObject({ status: "error", code: "TLS_FAILED" });
      await expect(reportSite(site).catch((error) => { throw safeConnectionFailure(error); }))
        .rejects.toMatchObject({ code: "TLS_FAILED" });
    }
  } finally {
    vi.stubEnv("WMS_MYSQL_CA_CERT", trustedCa);
  }
}, 30000);

test.skipIf(!enabled)("warehouse SQL CA renewal keeps temporary and final trust isolated", async () => {
  const first = {
    siteId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
    connectorUrl: "https://first.fixture.test", tokenEnv: "WMS_FIXTURE_FIRST_TOKEN",
    passwordEnv: "WMS_FIXTURE_SQL_PASSWORD", sqlCaEnv: "WMS_FIXTURE_FIRST_SQL_CA",
    host: input.host, port: fixturePort, database: input.database, username: input.username,
  };
  const second = {
    ...first,
    siteId: "33333333-3333-4333-8333-333333333333",
    connectorUrl: "https://second.fixture.test", tokenEnv: "WMS_FIXTURE_SECOND_TOKEN",
    sqlCaEnv: "WMS_FIXTURE_SECOND_SQL_CA", port: secondFixturePort,
  };
  vi.stubEnv(first.tokenEnv, "first-disposable-site-token-".repeat(3));
  vi.stubEnv(second.tokenEnv, "second-disposable-site-token-".repeat(3));
  vi.stubEnv(first.passwordEnv, fixturePasswords.reader);
  vi.stubEnv(first.sqlCaEnv, trustedCa);
  vi.stubEnv(second.sqlCaEnv, secondCa);
  // This remains the direct-mode trust root; site trust changes below must not alter it.
  vi.stubEnv("WMS_MYSQL_CA_CERT", trustedCa);

  const mapping = {
    view: "fixture_scoped_view", clientColumn: "client_code",
    siteColumn: "site_code", columns: { id: "id", label: "label" },
  };
  const reportScope = { clientKey: "fixture-client", siteKey: "fixture-site" };
  const setSites = () => vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([first, second]));
  const probeSite = (site: typeof first) => testConnection(
    { ...input, siteId: site.siteId, host: site.host, port: site.port }, { siteScope: site });
  const reportSite = (site: typeof first) => executeApprovedMysqlReport(
    mapping, reportScope, undefined, { siteScope: site });
  const expectSuccess = async (site: typeof first) => {
    expect(await probeSite(site)).toMatchObject({ status: "connected", code: "CONNECTED" });
    expect(await reportSite(site)).toMatchObject({
      rows: [{ id: 1, label: "disposable fixture row" }], truncated: false,
    });
  };
  const expectForeignIssuerRejected = async (site: typeof first, port: number) => {
    site.port = port;
    setSites();
    expect(await probeSite(site)).toMatchObject({ status: "error", code: "TLS_FAILED" });
    await expect(reportSite(site).catch((error) => { throw safeConnectionFailure(error); }))
      .rejects.toMatchObject({ code: "TLS_FAILED" });
  };
  const expectSecondWarehouseUnaffected = async () => {
    second.port = secondFixturePort;
    setSites();
    await expectSuccess(second);
  };
  const expectDirectTrustUnchanged = () => expect(process.env.WMS_MYSQL_CA_CERT).toBe(trustedCa);

  try {
    setSites();
    // Before renewal, the first warehouse trusts only its current certificate authority.
    first.port = fixturePort;
    await expectSuccess(first);
    expectDirectTrustUnchanged();
    await expectForeignIssuerRejected(first, renewedFixturePort);
    first.port = fixturePort;
    setSites();
    // The second warehouse always rejects the first warehouse's current and replacement issuers.
    await expectForeignIssuerRejected(second, fixturePort);
    await expectForeignIssuerRejected(second, renewedFixturePort);
    await expectSecondWarehouseUnaffected();

    // During overlap, both certificate generations work for the renewing warehouse.
    vi.stubEnv(first.sqlCaEnv, `${trustedCa}\n${renewedCa}`);
    first.port = fixturePort;
    setSites();
    await expectSuccess(first);
    first.port = renewedFixturePort;
    setSites();
    await expectSuccess(first);
    expectDirectTrustUnchanged();
    await expectForeignIssuerRejected(second, fixturePort);
    await expectForeignIssuerRejected(second, renewedFixturePort);
    await expectSecondWarehouseUnaffected();

    // After removing the old CA, the renewed server still works and the old server fails.
    vi.stubEnv(first.sqlCaEnv, renewedCa);
    first.port = renewedFixturePort;
    setSites();
    await expectSuccess(first);
    expectDirectTrustUnchanged();
    await expectForeignIssuerRejected(first, fixturePort);
    await expectForeignIssuerRejected(second, fixturePort);
    await expectForeignIssuerRejected(second, renewedFixturePort);
    await expectSecondWarehouseUnaffected();
    expectDirectTrustUnchanged();
  } finally {
    vi.stubEnv("WMS_MYSQL_CA_CERT", trustedCa);
  }
}, 45000);

test.skipIf(!enabled)("a stalled MySQL handshake times out and closes its socket", async () => {
  const accepted: Socket[] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.once("close", resolveClosed);
    // Deliberately do not send a MySQL greeting: this disposable local peer
    // exercises the driver's connection timeout and the probe's destroy path.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Timeout fixture did not bind a TCP port.");
  try {
    const result = await probe({}, fixturePasswords.reader, "127.0.0.1", address.port);
    expect(result.code).toBe("TIMEOUT");
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed-out socket was not closed.")), 1500)),
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].destroyed).toBe(true);
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
