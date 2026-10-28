import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { testConnection, safeConnectionFailure } from "./wms-connection";
import { TestWmsConnectionBody } from "@workspace/api-zod";

const input = { host: "8.8.8.8", port: 5432, database: "wms", schema: "reporting",
  username: "reporter", sslMode: "verify-full" as const, queryTimeoutSec: 30 };
const originalPool = pg.Pool;
const destinationKeys = ["WMS_APPROVED_HOST", "WMS_APPROVED_PORT", "WMS_APPROVED_DATABASE", "WMS_APPROVED_USERNAME"] as const;
const envKeys = ["WMS_PGPASSWORD", "WMS_DATABASE_URL", "WMS_CA_CERT", ...destinationKeys,
  "WMS_PRIVATE_NETWORK_ENABLED", "WMS_PRIVATE_NETWORK_CIDRS"] as const;
let saved: Partial<Record<typeof envKeys[number], string | undefined>>;
let configuration: pg.PoolConfig | undefined;
let queries: string[];
let released: boolean;
let ended: boolean;
let row: Record<string, boolean>;
let connectionError: Error | undefined;

class FakePool {
  constructor(config: pg.PoolConfig) { configuration = config; }
  on() {}
  async connect() {
    if (connectionError) throw connectionError;
    return {
      async query(sql: string) { queries.push(sql); return { rows: [row] }; },
      release(destroy: boolean) { released = destroy; },
    };
  }
  async end() { ended = true; }
}

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.WMS_PGPASSWORD = "unit-test-placeholder-not-a-real-password";
  process.env.WMS_APPROVED_HOST = input.host;
  process.env.WMS_APPROVED_PORT = String(input.port);
  process.env.WMS_APPROVED_DATABASE = input.database;
  process.env.WMS_APPROVED_USERNAME = input.username;
  configuration = undefined; queries = []; released = false; ended = false; connectionError = undefined;
  row = { schema_usage: true, privileged: false, writable: false, can_create: false, has_views: true };
  pg.Pool = FakePool as unknown as typeof pg.Pool;
});

afterEach(() => {
  pg.Pool = originalPool;
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test("success uses verified TLS, bounded pooling and metadata-only read-only queries", async () => {
  const result = await testConnection(input);
  assert.equal(result.status, "connected");
  assert.equal(result.lastSuccessfulAt, result.testedAt);
  assert.equal(configuration?.max, 1);
  assert.equal(configuration?.connectionTimeoutMillis, 8000);
  assert.equal(configuration?.statement_timeout, 15000);
  assert.match(configuration?.options ?? "", /default_transaction_read_only=on/);
  assert.equal((configuration?.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.match(queries[1], /information_schema.views/);
  assert.equal(queries[2], "ROLLBACK");
  assert.equal(released, true); assert.equal(ended, true);
});

test("privileged and write-capable accounts are rejected and connections destroyed", async () => {
  for (const key of ["privileged", "writable", "can_create"]) {
    row[key] = true;
    const result = await testConnection(input);
    assert.equal(result.code, "READ_ONLY_ROLE_REQUIRED");
    assert.equal(result.status, "error");
    assert.equal(released, true); assert.equal(ended, true);
    row[key] = false;
  }
});

test("missing schema access and missing reporting views cannot pass", async () => {
  row.schema_usage = false;
  assert.equal((await testConnection(input)).code, "SCHEMA_ACCESS_DENIED");
  row.schema_usage = true; row.has_views = false;
  assert.equal((await testConnection(input)).code, "REPORTING_VIEWS_REQUIRED");
});

test("private and loopback destinations stay blocked by default before opening a pool", async () => {
  for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254"]) {
    process.env.WMS_APPROVED_HOST = host;
    assert.equal((await testConnection({ ...input, host }, {
      resolveHost: async () => [{ address: host, family: 4 }],
    })).code, "HOST_NOT_ALLOWED");
    assert.equal(configuration, undefined);
  }
});

test("explicit private-network policy permits and pins only approved private VPN addresses", async () => {
  const host = "wms-db.vpn.example";
  process.env.WMS_APPROVED_HOST = host;
  process.env.WMS_PRIVATE_NETWORK_ENABLED = "true";
  process.env.WMS_PRIVATE_NETWORK_CIDRS = "10.40.0.0/16,fd42:1234::/48";
  const result = await testConnection({ ...input, host }, {
    resolveHost: async (resolvedHost) => {
      assert.equal(resolvedHost, host);
      return [
        { address: "10.40.12.34", family: 4 },
        { address: "fd42:1234::9", family: 6 },
      ];
    },
  });
  assert.equal(result.status, "connected");
  assert.equal(configuration?.host, "10.40.12.34", "the driver receives a pinned numeric address, not a hostname");
  assert.equal((configuration?.ssl as { servername: string }).servername, host, "TLS still verifies the approved hostname");
});

test("private mode refuses missing or unsafe network ranges before DNS lookup", async () => {
  process.env.WMS_PRIVATE_NETWORK_ENABLED = "true";
  for (const cidrs of [undefined, "", "0.0.0.0/0", "10.0.0.0/7", "127.0.0.0/8",
    "100.64.0.0/10", "fc00::/6", "not-a-cidr"]) {
    if (cidrs === undefined) delete process.env.WMS_PRIVATE_NETWORK_CIDRS;
    else process.env.WMS_PRIVATE_NETWORK_CIDRS = cidrs;
    let lookups = 0;
    const result = await testConnection(input, {
      resolveHost: async () => { lookups += 1; return [{ address: "10.40.1.4", family: 4 }]; },
    });
    assert.equal(result.code, cidrs === undefined || cidrs === "" ? "PRIVATE_NETWORK_NOT_CONFIGURED" : "NETWORK_POLICY_INVALID");
    assert.equal(lookups, 0);
    assert.equal(configuration, undefined);
  }
});

test("private mode rejects mixed and out-of-policy DNS answer sets", async () => {
  process.env.WMS_PRIVATE_NETWORK_ENABLED = "true";
  process.env.WMS_PRIVATE_NETWORK_CIDRS = "10.40.0.0/16";
  for (const addresses of [
    ["10.40.1.1", "10.41.1.1"],
    ["10.40.1.1", "8.8.8.8"],
    ["10.40.1.1", "127.0.0.1"],
  ]) {
    const result = await testConnection(input, {
      resolveHost: async () => addresses.map((address) => ({ address, family: 4 })),
    });
    assert.equal(result.code, "HOST_NOT_ALLOWED");
    assert.equal(configuration, undefined, "no PostgreSQL pool is opened for a mixed or unapproved answer");
  }
});

test("DNS answers are resolved once and the approved address stays pinned", async () => {
  const host = "wms-db.vpn.example";
  process.env.WMS_APPROVED_HOST = host;
  process.env.WMS_PRIVATE_NETWORK_ENABLED = "true";
  process.env.WMS_PRIVATE_NETWORK_CIDRS = "10.40.0.0/16";
  let lookups = 0;
  const result = await testConnection({ ...input, host }, {
    resolveHost: async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? "10.40.5.8" : "10.41.5.8", family: 4 }];
    },
  });
  assert.equal(result.status, "connected");
  assert.equal(lookups, 1);
  assert.equal(configuration?.host, "10.40.5.8");
});

test("missing or malformed server-side credentials fail without network activity", async () => {
  delete process.env.WMS_PGPASSWORD;
  for (const value of ["", "not-a-postgres-url", "https://example.invalid"]) {
    process.env.WMS_DATABASE_URL = value;
    assert.equal((await testConnection(input)).code, "PASSWORD_NOT_CONFIGURED");
    assert.equal(configuration, undefined);
  }
});

test("URL password cannot be sent to a destination that differs from its secret", async () => {
  delete process.env.WMS_PGPASSWORD;
  process.env.WMS_DATABASE_URL = "postgresql://reporter:fixture@8.8.4.4:5432/wms";
  assert.equal((await testConnection(input)).code, "SECRET_MISMATCH");
  assert.equal(configuration, undefined);
});

test("neither credential format can reach an alternate public host, port, database or username", async () => {
  for (const format of ["password", "url"]) {
    if (format === "url") {
      delete process.env.WMS_PGPASSWORD;
      process.env.WMS_DATABASE_URL = "postgresql://reporter:fixture@8.8.8.8:5432/wms";
      for (const key of destinationKeys) delete process.env[key];
    }
    for (const change of [{ host: "8.8.4.4" }, { port: 5433 }, { database: "other" }, { username: "other" }]) {
      assert.equal((await testConnection({ ...input, ...change })).code, "SECRET_MISMATCH");
      assert.equal(configuration, undefined, "No PostgreSQL client may receive the password");
      assert.deepEqual(queries, []);
    }
  }
});

test("standalone password requires a complete server-approved destination", async () => {
  for (const key of destinationKeys) delete process.env[key];
  assert.equal((await testConnection(input)).code, "DESTINATION_NOT_CONFIGURED");
  assert.equal(configuration, undefined);
  process.env.WMS_APPROVED_HOST = input.host;
  process.env.WMS_DATABASE_URL = "postgresql://reporter:fixture@8.8.8.8:5432/wms";
  assert.equal((await testConnection(input)).code, "DESTINATION_NOT_CONFIGURED",
    "Partial explicit configuration must not silently fall back to a URL");
  assert.equal(configuration, undefined);
});

test("a matching server URL safely binds either password source", async () => {
  for (const key of destinationKeys) delete process.env[key];
  process.env.WMS_DATABASE_URL = "postgresql://reporter:fixture@8.8.8.8:5432/wms";
  assert.equal((await testConnection(input)).status, "connected");
  assert.equal(configuration?.password, "unit-test-placeholder-not-a-real-password");
  delete process.env.WMS_PGPASSWORD;
  assert.equal((await testConnection(input)).status, "connected");
  assert.equal(configuration?.password, "fixture");
});

test("driver errors are sanitized and pools close on connection failure", async () => {
  connectionError = Object.assign(new Error("sensitive driver details"), { code: "28P01" });
  const result = await testConnection(input);
  assert.equal(result.code, "AUTHENTICATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /sensitive driver details/);
  assert.equal(ended, true);
  for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
    assert.equal(safeConnectionFailure({ code }).code, "TLS_FAILED");
  }
});

test("API rejects insecure TLS modes, passwords, SQL and invalid field values", () => {
  for (const extra of [{ sslMode: "disable" }, { sslMode: "require" }, { password: "fixture" },
    { sql: "SELECT 1" }, { host: "http://example.invalid" }, { port: 0 }, { queryTimeoutSec: 301 }]) {
    assert.equal(TestWmsConnectionBody.strict().safeParse({ ...input, ...extra }).success, false);
  }
});
