import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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

import { clientsTable, membersTable, rolesTable, sitesTable } from "@workspace/db/schema";
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
  canCreateOwnReports: false,
  active: true,
};
const site = {
  id: "site-a",
  clientId: "client-a",
  type: "test",
  name: "Synthetic site",
  active: true,
};
const path = "/api/access/reports/inbound-1/run";
const body = { siteId: "site-a" };

function runRequest(options: { origin?: string; fetchSite?: string } = {}) {
  let req = request(app).post(path)
    .set("Host", "wareiq.test")
    .set("X-Forwarded-Proto", "https");
  if (options.origin !== undefined) req = req.set("Origin", options.origin);
  if (options.fetchSite !== undefined) req = req.set("Sec-Fetch-Site", options.fetchSite);
  return req.send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.getUser.mockResolvedValue({
    banned: false,
    locked: false,
    publicMetadata: {},
    primaryEmailAddressId: "verified",
    emailAddresses: [{
      id: "verified",
      emailAddress: "reporter@example.test",
      verification: { status: "verified" },
    }],
  });
  provider.getSession.mockResolvedValue({ status: "active", userId: provider.userId });
  database.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async () => {
        if (table === membersTable) return [member];
        if (table === clientsTable) return [client];
        if (table === rolesTable) return [role];
        if (table === sitesTable) return [site];
        throw new Error("Unexpected database table in isolated report-run security test");
      },
    }),
  }));
});

describe("full-app origin protection for report runs", () => {
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
});
