import { beforeEach, describe, expect, it, vi } from "vitest";
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
const client = {
  id: "client-a",
  name: "Synthetic client",
  companyNumber: null,
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
  type: "test",
  name: "Synthetic site",
  active: true,
};

let memberFixture = member;
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

function runRequest(options: { origin?: string; fetchSite?: string; reportId?: string; siteId?: string } = {}) {
  let req = request(app).post(`/api/access/reports/${options.reportId ?? "inbound-1"}/run`)
    .set("Host", "wareiq.test")
    .set("X-Forwarded-Proto", "https");
  if (options.origin !== undefined) req = req.set("Origin", options.origin);
  if (options.fetchSite !== undefined) req = req.set("Sec-Fetch-Site", options.fetchSite);
  return req.send({ siteId: options.siteId ?? "site-a" });
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.userId = "reporter-a";
  provider.sessionId = "session-a";
  memberFixture = member;
  siteFixtures = [site];
  provider.getUser.mockImplementation(async () => ({
    banned: false,
    locked: false,
    publicMetadata: {},
    primaryEmailAddressId: "verified",
    emailAddresses: [{
      id: "verified",
      emailAddress: emailByUserId[provider.userId] ?? member.email,
      verification: { status: "verified" },
    }],
  }));
  provider.getSession.mockImplementation(async () => ({ status: "active", userId: provider.userId }));
  database.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        if (table === membersTable) {
          const email = emailByUserId[provider.userId] ?? member.email;
          return [member, otherMember].filter((candidate) => candidate.email === email);
        }
        if (table === clientsTable) return [client];
        if (table === rolesTable) return [role];
        if (table === sitesTable) return siteFixtures.filter((site) => site.active);
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
});

describe("full-app authorization for report runs", () => {
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

  it("denies another user from running the report owner's personal report", async () => {
    provider.userId = "reporter-b";

    const response = await runRequest({
      reportId: "another-owner-report",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Your role does not grant access to this report." });
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it("denies an owner from running their personal report under another client", async () => {
    const response = await runRequest({
      reportId: "another-client-report",
      origin: "https://wareiq.test",
      fetchSite: "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Your role does not grant access to this report." });
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
    expect(poolConstructor).not.toHaveBeenCalled();
  });
});
