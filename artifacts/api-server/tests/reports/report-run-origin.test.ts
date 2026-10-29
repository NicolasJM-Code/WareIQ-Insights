import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";

const provider = vi.hoisted(() => ({
  userId: "reporter-a",
  sessionId: "session-a",
  getUser: vi.fn(),
  getSession: vi.fn(),
}));
const poolConstructor = vi.hoisted(() => vi.fn());
const database = vi.hoisted(() => ({ select: vi.fn() }));
const executeMysqlReport = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/wms-vpn-monitor", () => ({
  warehouseVpnHealth: async () => ({ status: "unknown", checkedAt: null }),
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: () => ({ userId: provider.userId, sessionId: provider.sessionId }),
  clerkClient: {
    users: { getUser: provider.getUser },
    sessions: { getSession: provider.getSession },
  },
}));
vi.mock("@clerk/shared/keys", () => ({ publishableKeyFromHost: () => "isolated-test-key" }));
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: database,
}));
vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    ...actual,
    default: { ...actual.default, Pool: poolConstructor },
  };
});
vi.mock("../../src/lib/wms-connection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/wms-connection")>(),
  executeApprovedMysqlReport: executeMysqlReport,
}));
vi.mock("pino-http", () => ({
  default: () => (req: { log: unknown }, _res: unknown, next: () => void) => {
    req.log = { error: () => undefined, warn: () => undefined, info: () => undefined };
    next();
  },
}));
vi.mock("../../src/lib/logger", () => ({ logger: {} }));

import { clientsTable, membersTable, ownReportsTable, rolesTable, sitesTable } from "@workspace/db/schema";
import app from "../../src/app";

const member = {
  email: "reporter@example.test",
  name: "Synthetic reporter",
  clientId: "client-a",
  roleId: "role-a",
  siteIds: ["site-a"],
  primarySiteId: "site-a",
  active: true,
};
const otherMember = {
  ...member,
  email: "reporter-b@example.test",
  name: "Synthetic second reporter",
};
const clientBrandings = [
  {
    name: "null branding",
    fields: {
      companyNumber: null, addressLine1: null, addressLine2: null, city: null,
      region: null, postalCode: null, country: null, logoPath: null,
    },
  },
  {
    name: "populated branding",
    fields: {
      companyNumber: "COMPANY-01", addressLine1: "42 Test Street", addressLine2: "Unit 7",
      city: "Example City", region: "Example Region", postalCode: "AB12 3CD", country: "GB",
      logoPath: "/objects/client-logos/client-a/logo.png",
    },
  },
];
const client = {
  id: "client-a",
  name: "Synthetic client",
  companyNumber: "COMPANY-01",
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
  logoPath: null,
  active: true,
};
const role = {
  id: "role-a",
  clientId: "client-a",
  name: "Synthetic reporter",
  reportIds: ["inbound-1"],
  ownReportSections: ["inbound"],
  canCreateOwnReports: true,
  active: true,
};
const site = {
  id: "site-a",
  clientId: "client-a",
  sourceId: "WAREHOUSE-01",
  type: "test",
  name: "Synthetic site",
  active: true,
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  contactPhone: "",
};

let memberFixture = member;
let clientFixture: Omit<typeof client, keyof typeof clientBrandings[number]["fields"]>
  & Record<keyof typeof clientBrandings[number]["fields"], string | null> = client;
let roleFixture = role;
let identityReadCount = 0;
let deactivateMemberOnRevalidation = false;
const privateReports = [
  {
    id: "another-owner-report",
    ownerId: "reporter-a",
    clientId: "client-a",
    definition: { section: "inbound", dataset: "receipts", fields: ["id"], name: "Private to reporter A" },
  },
  {
    id: "another-client-report",
    ownerId: "reporter-a",
    clientId: "client-b",
    definition: { section: "inbound", dataset: "receipts", fields: ["id"], name: "Private to client B" },
  },
  {
    id: "reporter-a-report",
    ownerId: "reporter-a",
    clientId: "client-a",
    definition: { section: "inbound", dataset: "receipts", fields: ["id"], name: "Reporter A report" },
  },
];
const emailByUserId: Record<string, string> = {
  "reporter-a": member.email,
  "reporter-b": otherMember.email,
};
let siteFixtures = [site];

function runRequest(options: {
  origin?: string;
  fetchSite?: string;
  reportId?: string;
  siteId?: string;
  body?: Record<string, unknown>;
} = {}) {
  let req = request(app).post(`/api/access/reports/${options.reportId ?? "inbound-1"}/run`)
    .set("Host", "wareiq.test")
    .set("X-Forwarded-Proto", "https");
  if (options.origin !== undefined) req = req.set("Origin", options.origin);
  if (options.fetchSite !== undefined) req = req.set("Sec-Fetch-Site", options.fetchSite);
  return req.send(options.body === undefined ? { siteId: options.siteId ?? "site-a" } : options.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", undefined);
  identityReadCount = 0;
  deactivateMemberOnRevalidation = false;
  provider.userId = "reporter-a";
  provider.sessionId = "session-a";
  memberFixture = member;
  clientFixture = client;
  roleFixture = role;
  siteFixtures = [site];
  provider.getUser.mockImplementation(async () => {
    identityReadCount++;
    if (deactivateMemberOnRevalidation && identityReadCount === 2)
      memberFixture = { ...member, active: false };
    return {
      banned: false,
      locked: false,
      publicMetadata: {},
      primaryEmailAddressId: "verified",
      emailAddresses: [{
        id: "verified",
        emailAddress: emailByUserId[provider.userId] ?? member.email,
        verification: { status: "verified" },
      }],
    };
  });
  provider.getSession.mockImplementation(async () => ({ status: "active", userId: provider.userId }));
  database.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        if (table === membersTable) {
          const email = emailByUserId[provider.userId] ?? member.email;
          return [memberFixture, otherMember].filter((candidate) => candidate.email === email);
        }
        if (table === clientsTable) return [clientFixture];
        if (table === rolesTable) return [roleFixture];
        if (table === sitesTable)
          return siteFixtures.filter((site) => site.clientId === clientFixture.id && site.active);
        if (table === ownReportsTable) {
          const query = new PgDialect().sqlToQuery(condition);
          const constraints = new Map<string, unknown>();
          for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)/g)) {
            constraints.set(match[1], query.params[Number(match[2]) - 1]);
          }
          const rowValues: Record<string, (row: typeof privateReports[number]) => unknown> = {
            id: (row) => row.id,
            owner_id: (row) => row.ownerId,
            client_id: (row) => row.clientId,
          };
          return privateReports.filter((row) => [...constraints].every(([column, value]) =>
            !rowValues[column] || rowValues[column](row) === value));
        }
        throw new Error("Unexpected database table in isolated report-run security test");
      },
    }),
  }));
  executeMysqlReport.mockResolvedValue({ columns: ["id"], rows: [{ id: "GRN-1" }], truncated: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("full-app authorization for report runs", () => {
  describe.each(clientBrandings)("approved users with $name", ({ fields }) => {
    it.each(["inbound-1", "reporter-a-report"])(
      "denies %s without assigned sites and authorizes it after assignment", async (reportId) => {
        clientFixture = { ...client, ...fields };
        memberFixture = { ...member, siteIds: [] };
        // An imported active site exists, but its ID must not be usable until
        // this member is assigned it. Mappings ensure denial is not a no-WMS fallback.
        const mapping = {
          view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
          columns: { id: "receipt_id" },
        };
        vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
          "inbound-1": mapping, "own:inbound:receipts": mapping,
        }));

        const pending = await request(app).get("/api/access/me");
        expect(pending.status).toBe(200);
        expect(pending.body).toMatchObject({
          status: "pending_sites", platformAdmin: false, clientId: client.id,
          reportIds: role.reportIds, ownReportSections: role.ownReportSections,
          canCreateOwnReports: true, sites: [],
          clientCompanyNumber: fields.companyNumber,
          clientAddressLine1: fields.addressLine1, clientAddressLine2: fields.addressLine2,
          clientCity: fields.city, clientRegion: fields.region,
          clientPostalCode: fields.postalCode, clientCountry: fields.country,
          clientLogoUrl: fields.logoPath ? "/api/access/clients/client-a/logo" : null,
        });

        const denied = await runRequest({
          reportId, origin: "https://wareiq.test", fetchSite: "same-origin",
        });
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: "This site is not assigned to you." });
        expect(executeMysqlReport).not.toHaveBeenCalled();
        expect(poolConstructor).not.toHaveBeenCalled();

        memberFixture = { ...member };
        const active = await request(app).get("/api/access/me");
        expect(active.status).toBe(200);
        expect(active.body).toMatchObject({
          status: "active", sites: [{ id: site.id, clientId: client.id, sourceId: site.sourceId }],
        });

        const authorized = await runRequest({
          reportId, origin: "https://wareiq.test", fetchSite: "same-origin",
        });
        expect(authorized.status).toBe(200);
        if (fields.companyNumber) {
          expect(authorized.body.status).toBe("completed");
          expect(executeMysqlReport).toHaveBeenCalledOnce();
          expect(executeMysqlReport).toHaveBeenCalledWith(
            expect.objectContaining({ view: "v_receipts" }),
            { clientKey: fields.companyNumber, siteKey: site.sourceId },
            reportId === "inbound-1" ? undefined : ["id"],
            { siteScope: { siteId: site.id, clientId: client.id } },
          );
        } else {
          // Site approval does not replace the required client reporting key.
          expect(authorized.body).toMatchObject({ status: "not_connected", rows: [] });
          expect(executeMysqlReport).not.toHaveBeenCalled();
        }
        expect(poolConstructor).not.toHaveBeenCalled();
      },
    );

    it("keeps execution denied when assigned sites have not been imported", async () => {
      clientFixture = { ...client, ...fields };
      siteFixtures = [];
      const pending = await request(app).get("/api/access/me");
      expect(pending.status).toBe(200);
      expect(pending.body).toMatchObject({
        status: "pending_sites", reportIds: role.reportIds, sites: [],
      });
      const denied = await runRequest({ origin: "https://wareiq.test", fetchSite: "same-origin" });
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: "This site is not assigned to you." });
      expect(executeMysqlReport).not.toHaveBeenCalled();
      expect(poolConstructor).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["missing Origin", {}],
    ["foreign Origin", { origin: "https://foreign.test" }],
    ["cross-site fetch metadata", { origin: "https://wareiq.test", fetchSite: "cross-site" }],
  ] as const)("blocks a report run with %s before authorization or WMS access", async (_label, options) => {
    const response = await runRequest(options);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "A same-origin request is required." });
    expect(provider.getSession).not.toHaveBeenCalled();
    expect(provider.getUser).not.toHaveBeenCalled();
    expect(database.select).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("allows an authorized same-origin report run without opening a WMS connection", async () => {
    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "not_connected" });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(database.select).toHaveBeenCalledTimes(4);
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies an inactive member before opening a WMS connection", async () => {
    memberFixture = { ...member, active: false };

    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Your administrator must approve an active client and role before you can use reports.",
    });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(database.select).toHaveBeenCalled();
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies a member of an inactive client before opening a WMS connection", async () => {
    clientFixture = { ...client, active: false };

    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Your administrator must approve an active client and role before you can use reports.",
    });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(database.select).toHaveBeenCalled();
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty string", { siteId: "" }],
    ["a number", { siteId: 42 }],
    ["null", { siteId: null }],
    ["an object", { siteId: { id: "site-a" } }],
  ])("rejects %s site IDs before WMS access", async (_label, body) => {
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "inbound-1": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));

    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
      body,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Check all required fields and selections." });
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("runs a mapped standard report with the authorized client and site source keys", async () => {
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "inbound-1": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));
    const response = await runRequest({ origin: "https://wareiq.test", fetchSite: "same-origin" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "completed", columns: ["id"], rows: [{ id: "GRN-1" }] });
    expect(provider.getUser).toHaveBeenCalledTimes(2);
    expect(database.select).toHaveBeenCalledTimes(8);
    expect(executeMysqlReport).toHaveBeenCalledOnce();
    expect(executeMysqlReport).toHaveBeenCalledWith(
      expect.objectContaining({ view: "v_receipts" }),
      { clientKey: "COMPANY-01", siteKey: "WAREHOUSE-01" },
      undefined,
      { siteScope: { siteId: "site-a", clientId: "client-a" } },
    );
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("does not start a report query when the member is deactivated before warehouse execution", async () => {
    deactivateMemberOnRevalidation = true;
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "inbound-1": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));

    const response = await runRequest({ origin: "https://wareiq.test", fetchSite: "same-origin" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Your administrator must approve an active client and role before you can use reports.",
    });
    expect(provider.getUser).toHaveBeenCalledTimes(2);
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies a standard report absent from the role grants before opening a WMS connection", async () => {
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "inbound-2": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));

    const response = await runRequest({
      reportId: "inbound-2",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Your role does not grant access to this report." });
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("uses owner/client-bound personal report definitions for MySQL field selection", async () => {
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "own:inbound:receipts": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));
    const response = await runRequest({
      reportId: "reporter-a-report", origin: "https://wareiq.test", fetchSite: "same-origin",
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("completed");
    expect(executeMysqlReport).toHaveBeenCalledWith(
      expect.objectContaining({ view: "v_receipts" }),
      { clientKey: "COMPANY-01", siteKey: "WAREHOUSE-01" },
      ["id"],
      { siteScope: { siteId: "site-a", clientId: "client-a" } },
    );
  });

  it("denies another user from running the report owner's personal report", async () => {
    provider.userId = "reporter-b";
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "own:inbound:receipts": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));

    const response = await runRequest({
      reportId: "another-owner-report",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Your role does not grant access to this report." });
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies an owner from running their personal report under another client", async () => {
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "own:inbound:receipts": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));
    const response = await runRequest({
      reportId: "another-client-report",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Your role does not grant access to this report." });
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("allows an eligible owner to run their own report without opening a WMS connection", async () => {
    const response = await runRequest({
      reportId: "reporter-a-report",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "not_connected" });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(database.select).toHaveBeenCalledTimes(5);
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies an owner whose role no longer grants the personal report section", async () => {
    roleFixture = { ...role, ownReportSections: ["inventory"] };
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "own:inbound:receipts": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));

    const response = await runRequest({
      reportId: "reporter-a-report",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Your role does not grant access to this report." });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(database.select).toHaveBeenCalledTimes(5);
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("rejects an inactive site before opening a WMS connection", async () => {
    siteFixtures = [{ ...site, active: false }];

    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "This site is not assigned to you." });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("rejects a site no longer assigned to the member before opening a WMS connection", async () => {
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "inbound-1": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));
    siteFixtures = [site, {
      ...site,
      id: "site-b",
      name: "Unassigned synthetic site",
    }];

    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
      siteId: "site-b",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "This site is not assigned to you." });
    expect(provider.getSession).toHaveBeenCalledOnce();
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies an assigned warehouse from another client before opening reporting connections", async () => {
    const foreignClientSite = {
      ...site,
      id: "site-client-b",
      clientId: "client-b",
      sourceId: "WAREHOUSE-CLIENT-B",
      name: "Other client's active warehouse",
    };
    memberFixture = { ...member, siteIds: [site.id, foreignClientSite.id] };
    siteFixtures = [site, foreignClientSite];
    vi.stubEnv("WMS_MYSQL_REPORT_MAPPINGS", JSON.stringify({
      "inbound-1": {
        view: "v_receipts", clientColumn: "client_code", siteColumn: "warehouse_code",
        columns: { id: "receipt_id" },
      },
    }));

    const response = await runRequest({
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
      siteId: foreignClientSite.id,
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "This site is not assigned to you." });
    expect(database.select).toHaveBeenCalledTimes(4);
    expect(executeMysqlReport).not.toHaveBeenCalled();
    expect(poolConstructor).not.toHaveBeenCalled();
  });
});
