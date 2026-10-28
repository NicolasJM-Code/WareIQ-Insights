import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { ConnectionOptions } from "mysql2";
import { TestWmsConnectionBody } from "@workspace/api-zod";

const fake = vi.hoisted(() => ({
  create: vi.fn(), query: vi.fn(), destroy: vi.fn(), socket: vi.fn(), lookup: vi.fn(),
  pg: vi.fn(),
}));
vi.mock("mysql2", () => ({ default: { createConnection: fake.create } }));
vi.mock("pg", () => ({ default: { Pool: fake.pg } }));
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
vi.mock("node:net", async (original) => ({
  ...await original<typeof import("node:net")>(), createConnection: fake.socket,
}));
import { testConnection } from "../src/lib/wms-connection";
import {
  getMysqlReportMapping, mysqlGrantsAreReadOnly, runMysqlReport,
} from "../src/lib/wms-mysql-connection";

const input = {
  engine: "mysql" as const, host: "wms.example.test", port: 3306,
  database: "reporting", schema: "reporting", username: "reporter",
  sslMode: "verify-full" as const, queryTimeoutSec: 30,
};
const approved = {
  WMS_MYSQL_DATABASE_URL: "mysql://reporter:fixture@wms.example.test/reporting",
  WMS_MYSQL_PASSWORD: "", WMS_MYSQL_CA_CERT: "",
  WMS_MYSQL_APPROVED_HOST: "", WMS_MYSQL_APPROVED_PORT: "",
  WMS_MYSQL_APPROVED_DATABASE: "", WMS_MYSQL_APPROVED_USERNAME: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WMS_PRIVATE_NETWORK_ENABLED", undefined);
  vi.stubEnv("WMS_PRIVATE_NETWORK_CIDRS", undefined);
  // Undefined, not blank: explicit partial destination overrides fail closed.
  for (const key of Object.keys(approved)) vi.stubEnv(key, undefined);
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", approved.WMS_MYSQL_DATABASE_URL);
  fake.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  fake.create.mockReturnValue({
    on: vi.fn(), promise: () => ({ query: fake.query }), destroy: fake.destroy,
  });
  fake.query.mockImplementation(async ({ sql }: { sql: string }) => {
    const rows = sql.includes("CURRENT_ROLE") ? [{ active_roles: "NONE" }]
      : sql === "SHOW GRANTS" ? [{ grant: "GRANT SELECT, SHOW VIEW ON `reporting`.* TO `reporter`@`%`" }]
      : sql.includes("MAX_EXECUTION_TIME") ? [{ sku: "SKU-1", quantity: 7 }]
      : sql.includes("information_schema") ? [{ name: "reporting_view" }] : [];
    return [rows, []];
  });
});
afterEach(() => vi.unstubAllEnvs());

test("report mappings select only approved fields and bind mandatory client/site filters", async () => {
  const mapping = getMysqlReportMapping("own:inventory:stock", JSON.stringify({
    "own:inventory:stock": {
      view: "v_stock_on_hand", clientColumn: "client_code", siteColumn: "site_code",
      columns: { sku: "item_sku", quantity: "on_hand" },
    },
  }));
  expect(mapping).toBeDefined();
  const result = await runMysqlReport(input, "fixture", "8.8.8.8", mapping!, {
    clientKey: "CLIENT-42", siteKey: "WH-9",
  }, ["sku"]);
  expect(result).toEqual({ columns: ["sku"], rows: [{ sku: "SKU-1" }], truncated: false });
  const reportQuery = fake.query.mock.calls.map(([query]) => query)
    .find((query) => query.sql.includes("MAX_EXECUTION_TIME"));
  expect(reportQuery.sql).toContain("`reporting`.`v_stock_on_hand`");
  expect(reportQuery.sql).toContain("`client_code` = ? AND `site_code` = ?");
  expect(reportQuery.sql).toContain("`item_sku` AS `sku`");
  expect(reportQuery.sql).toContain("LIMIT 501");
  expect(reportQuery.values).toEqual(["CLIENT-42", "WH-9"]);
  expect(reportQuery.timeout).toBe(15000);
  expect(fake.query.mock.calls.at(-1)?.[0]?.sql).toBe("ROLLBACK");
  expect(fake.destroy).toHaveBeenCalledOnce();
});

test("MySQL report execution caps rows and marks the result truncated", async () => {
  const mapping = {
    view: "v_stock", clientColumn: "client_id", siteColumn: "site_id", columns: { sku: "sku" },
  };
  fake.query.mockImplementation(async ({ sql }: { sql: string }) => {
    if (sql.includes("CURRENT_ROLE")) return [[{ active_roles: "NONE" }], []];
    if (sql === "SHOW GRANTS") return [[{ grant: "GRANT SELECT, SHOW VIEW ON `reporting`.* TO `reporter`@`%`" }], []];
    if (sql.includes("MAX_EXECUTION_TIME"))
      return [Array.from({ length: 501 }, (_, index) => ({ sku: `SKU-${index}` })), []];
    return [[], []];
  });
  const result = await runMysqlReport(input, "fixture", "8.8.8.8", mapping, {
    clientKey: "client", siteKey: "site",
  });
  expect(result.rows).toHaveLength(500);
  expect(result.truncated).toBe(true);
  expect(result.rows[0]).toEqual({ sku: "SKU-0" });
});

test("MySQL mappings reject unsafe identifiers, extra SQL and unapproved report fields", async () => {
  for (const mapping of [
    '{"inventory-1":{"view":"v_stock; DROP TABLE x","clientColumn":"client_id","siteColumn":"site_id","columns":{"sku":"sku"}}}',
    '{"inventory-1":{"view":"v_stock","clientColumn":"client_id","siteColumn":"site_id","columns":{"sku":"sku"},"where":"1=1"}}',
  ]) expect(() => getMysqlReportMapping("inventory-1", mapping)).toThrow();
  const mapping = getMysqlReportMapping("inventory-1", JSON.stringify({
    "inventory-1": { view: "v_stock", clientColumn: "client_id", siteColumn: "site_id", columns: { sku: "sku" } },
  }))!;
  await expect(runMysqlReport(input, "fixture", "8.8.8.8", mapping,
    { clientKey: "client", siteKey: "site" }, ["unapproved"])).rejects.toThrow();
  expect(fake.create).not.toHaveBeenCalled();
});

test("MySQL probe uses pinned TCP, verified TLS, bounded metadata queries and cleanup", async () => {
  expect((await testConnection(input)).status).toBe("connected");
  const config = fake.create.mock.calls[0][0] as ConnectionOptions;
  expect(config.host).toBe(input.host);
  expect(config.password).toBe("fixture");
  expect(config.ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true });
  expect(config.multipleStatements).toBe(false);
  expect(config.connectTimeout).toBe(8000);
  (config.stream as () => unknown)();
  expect(fake.socket).toHaveBeenCalledWith({ host: "8.8.8.8", port: 3306 });
  const calls = fake.query.mock.calls.map(([query]) => query);
  expect(calls[0].sql).toBe("START TRANSACTION READ ONLY");
  expect(calls.at(-1).sql).toBe("ROLLBACK");
  expect(calls.every((query) => query.timeout === 15000)).toBe(true);
  expect(calls.find((query) => query.sql.includes("VIEWS")).values).toEqual(["reporting"]);
  expect(fake.pg).not.toHaveBeenCalled();
  expect(fake.destroy).toHaveBeenCalledOnce();
});

test("grant checks reject write, elevated, role, column and grant-option permissions", () => {
  expect(mysqlGrantsAreReadOnly(["GRANT USAGE ON *.* TO `a`@`%`",
    "GRANT SELECT, SHOW VIEW ON `reporting`.* TO `a`@`%`"])).toBe(true);
  for (const grant of ["GRANT ALL PRIVILEGES ON *.* TO `a`@`%`",
    "GRANT SELECT, INSERT ON `reporting`.* TO `a`@`%`",
    "GRANT FILE ON *.* TO `a`@`%`", "GRANT `role`@`%` TO `a`@`%`",
    "GRANT SELECT ON *.* TO `a`@`%` WITH GRANT OPTION",
    "GRANT EXECUTE ON PROCEDURE `db`.`proc` TO `a`@`%`",
    "GRANT SELECT (`column`) ON `db`.`table` TO `a`@`%`"]) {
    expect(mysqlGrantsAreReadOnly([grant]), grant).toBe(false);
  }
  expect(mysqlGrantsAreReadOnly([])).toBe(false);
});

test("active roles, absent views, and inaccessible schemas cannot pass", async () => {
  for (const [pattern, rows, code] of [
    ["CURRENT_ROLE", [{ active_roles: "`elevated`@`%`" }], "READ_ONLY_ROLE_REQUIRED"],
    ["SCHEMATA", [], "SCHEMA_ACCESS_DENIED"],
    ["VIEWS", [], "REPORTING_VIEWS_REQUIRED"],
  ] as const) {
    const normalQuery = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (options) =>
      options.sql.includes(pattern) ? [rows, []] : normalQuery(options));
    expect((await testConnection(input)).code).toBe(code);
    fake.query.mockImplementation(normalQuery);
  }
  expect(fake.destroy).toHaveBeenCalledTimes(3);
});

test("MySQL secrets never fall back to PostgreSQL and mismatches never reach DNS", async () => {
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", undefined);
  vi.stubEnv("WMS_PGPASSWORD", "pg-placeholder");
  vi.stubEnv("WMS_DATABASE_URL", "postgresql://reporter:fixture@wms.example.test/reporting");
  expect((await testConnection(input)).code).toBe("PASSWORD_NOT_CONFIGURED");
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", approved.WMS_MYSQL_DATABASE_URL);
  for (const change of [{ host: "elsewhere.test" }, { port: 3307 },
    { database: "other", schema: "other" }, { username: "other" }]) {
    expect((await testConnection({ ...input, ...change })).code).toBe("SECRET_MISMATCH");
  }
  expect(fake.lookup).not.toHaveBeenCalled();
  expect(fake.create).not.toHaveBeenCalled();
});

test("standalone password needs complete destination approval; partial overrides fail", async () => {
  vi.stubEnv("WMS_MYSQL_PASSWORD", "standalone-placeholder");
  vi.stubEnv("WMS_MYSQL_APPROVED_HOST", input.host);
  expect((await testConnection(input)).code).toBe("DESTINATION_NOT_CONFIGURED");
  vi.stubEnv("WMS_MYSQL_APPROVED_PORT", String(input.port));
  vi.stubEnv("WMS_MYSQL_APPROVED_DATABASE", input.database);
  vi.stubEnv("WMS_MYSQL_APPROVED_USERNAME", input.username);
  vi.stubEnv("WMS_MYSQL_DATABASE_URL", undefined);
  expect((await testConnection(input)).status).toBe("connected");
  expect(fake.create.mock.calls[0][0].password).toBe("standalone-placeholder");
});

test("private DNS, numeric hosts and different schemas fail without a driver", async () => {
  expect((await testConnection({ ...input, schema: "other" })).code).toBe("SCHEMA_MISMATCH");
  expect((await testConnection({ ...input, host: "8.8.8.8" })).code).toBe("TLS_HOSTNAME_REQUIRED");
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254"]) {
    fake.lookup.mockResolvedValue([{ address, family: 4 }]);
    expect((await testConnection(input)).code).toBe("HOST_NOT_ALLOWED");
  }
  expect(fake.create).not.toHaveBeenCalled();
});

test("private MySQL endpoints require the shared owner-approved CIDR policy", async () => {
  fake.lookup.mockResolvedValue([{ address: "10.40.0.3", family: 4 }]);
  vi.stubEnv("WMS_PRIVATE_NETWORK_ENABLED", "true");
  vi.stubEnv("WMS_PRIVATE_NETWORK_CIDRS", "10.40.0.0/24");
  expect((await testConnection(input)).status).toBe("connected");
  fake.create.mockClear();
  fake.lookup.mockResolvedValue([
    { address: "10.40.0.3", family: 4 }, { address: "8.8.8.8", family: 4 },
  ]);
  expect((await testConnection(input)).code).toBe("HOST_NOT_ALLOWED");
  expect(fake.create).not.toHaveBeenCalled();
});

test("MySQL driver errors are sanitized and every connected probe is destroyed", async () => {
  for (const [code, expected] of [
    ["ER_ACCESS_DENIED_ERROR", "AUTHENTICATION_FAILED"],
    ["ER_BAD_DB_ERROR", "DATABASE_NOT_FOUND"],
    ["ER_DBACCESS_DENIED_ERROR", "ACCESS_DENIED"],
    ["CERT_HAS_EXPIRED", "TLS_FAILED"],
    ["PROTOCOL_SEQUENCE_TIMEOUT", "TIMEOUT"],
  ]) {
    fake.query.mockRejectedValueOnce(Object.assign(new Error("sensitive driver payload"), { code }));
    const result = await testConnection(input);
    expect(result.code).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("sensitive driver payload");
  }
  expect(fake.destroy).toHaveBeenCalledTimes(5);
});

test("contract accepts both engines, defaults legacy PostgreSQL and rejects unsafe inputs", () => {
  expect(TestWmsConnectionBody.parse(input).engine).toBe("mysql");
  const { engine: _engine, ...legacy } = input;
  expect(TestWmsConnectionBody.parse(legacy).engine).toBe("postgresql");
  for (const extra of [{ engine: "sqlserver" }, { sslMode: "disable" }, { password: "not-allowed" }, { sql: "SELECT 1" }]) {
    expect(TestWmsConnectionBody.strict().safeParse({ ...input, ...extra }).success).toBe(false);
  }
});
