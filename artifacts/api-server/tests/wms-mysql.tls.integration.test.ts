import { createServer, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import type { WmsConnectionInput, WmsConnectionResult } from "@workspace/api-zod";
import { safeConnectionFailure } from "../src/lib/wms-connection";
import { testMysqlConnection } from "../src/lib/wms-mysql-connection";

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
let trustedCa = "";

beforeAll(async () => {
  if (!enabled) return;
  const fixtureDir = process.env.WMS_MYSQL_TLS_FIXTURE_DIR;
  const port = Number(process.env.WMS_MYSQL_TLS_FIXTURE_PORT);
  if (!fixtureDir || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The disposable MySQL TLS fixture runner did not provide its connection details.");
  }
  fixturePort = port;
  trustedCa = await readFile(`${fixtureDir}/certs/ca.pem`, "utf8");
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
