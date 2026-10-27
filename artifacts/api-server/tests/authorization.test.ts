import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Identity is assigned by the test, NEVER derived from request headers.
const provider = vi.hoisted(() => ({
  userId: null as string | null,
  claims: {} as Record<string, unknown>,
  getUser: vi.fn(),
  sessionId: "sess_isolated",
  getSession: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: () => ({ userId: provider.userId, sessionId: provider.sessionId, sessionClaims: provider.claims }),
  clerkClient: { users: { getUser: provider.getUser }, sessions: { getSession: provider.getSession } },
}));
vi.mock("@clerk/shared/keys", () => ({ publishableKeyFromHost: () => "isolated-test-key" }));
vi.mock("pino-http", () => ({
  default: () => (req: { log: unknown }, _res: unknown, next: () => void) => {
    req.log = { warn: provider.warn };
    next();
  },
}));
vi.mock("../src/lib/logger", () => ({ logger: {} }));
// Verified identities may look up membership, but no live pool is constructed.
// Empty membership reads are allowed; all other database operations throw.
vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return {
    ...schema,
    db: { select: () => ({ from: (table: unknown) => {
      if (table !== schema.membersTable) throw new Error("Unexpected database access in isolated authorization test");
      return { where: async () => [] };
    } }) },
  };
});

import app from "../src/app";
import router from "../src/routes";
import { appRole, requireAdministrator, requireReporter } from "../src/middlewares/access";

// Test-only handlers are appended AFTER the actual central guards. This catches
// ordering regressions without adding dummy reporting APIs to production.
const reached = vi.fn();
const reportPaths = ["/reports/regression", "/exports/regression", "/future-report"];
const adminPaths = ["/settings/regression", "/config/regression", "/connection/regression", "/admin/regression"];
for (const path of [...reportPaths, ...adminPaths]) {
  router.all(path, (_req, res) => {
    reached();
    res.json({ role: res.locals.access.role });
  });
}

function account(role: unknown = "admin", extra = {}) {
  return {
    publicMetadata: { role }, unsafeMetadata: {}, banned: false, locked: false,
    emailAddresses: [{ id: "email_isolated", emailAddress: "isolated@example.com", verification: { status: "verified" } }],
    primaryEmailAddressId: "email_isolated", ...extra,
  };
}
function signIn(role: unknown = "admin", extra = {}) {
  provider.userId = "user_isolated_a";
  provider.getUser.mockResolvedValue(account(role, extra));
}
function mutation(method: "post" | "put" | "patch" | "delete", path = "/api/settings/regression") {
  return request(app)[method](path).set("Host", "wareiq.test").set("X-Forwarded-Proto", "https");
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.userId = null;
  provider.claims = {};
  provider.getUser.mockReset();
  provider.sessionId = "sess_isolated";
  provider.getSession.mockReset();
  provider.getSession.mockImplementation(async () => ({ status: "active", userId: provider.userId }));
});

describe("identity and central route authorization", () => {
  it.each(["revoked", "ended", "expired", "abandoned", "removed"])(
    "denies a currently %s session across membership and legacy routes", async (status) => {
      signIn();
      expect((await request(app).get("/api/reports/regression")).status).toBe(200);
      reached.mockClear();
      provider.getUser.mockClear();
      provider.getSession.mockResolvedValue({ status, userId: provider.userId });
      for (const path of ["/api/access/me", "/api/access/own-reports", "/api/auth/session", "/api/reports/regression"]) {
        const res = await request(app).get(path);
        expect(res.status).toBe(401);
        expect(res.headers["cache-control"]).toBe("private, no-store");
      }
      expect(reached).not.toHaveBeenCalled();
      expect(provider.getUser).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or mismatched sessions and fails closed on session lookup outages", async () => {
    signIn();
    provider.sessionId = "";
    expect((await request(app).get("/api/access/me")).status).toBe(401);
    expect(provider.getSession).not.toHaveBeenCalled();
    provider.sessionId = "sess_isolated";
    provider.getSession.mockResolvedValue({ status: "active", userId: "user_someone_else" });
    expect((await request(app).get("/api/reports/regression")).status).toBe(401);
    provider.getSession.mockRejectedValue({ status: 404 });
    expect((await request(app).get("/api/access/me")).status).toBe(401);
    provider.getSession.mockRejectedValue(new Error("private-provider-error"));
    const failed = await request(app).get("/api/access/me");
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("private-provider-error");
    expect(reached).not.toHaveBeenCalled();
  });

  it("keeps health public without consulting the identity provider", async () => {
    expect((await request(app).get("/api/healthz")).status).toBe(200);
    expect(provider.getUser).not.toHaveBeenCalled();
  });

  it.each(["/auth/session", "/settings/access", ...reportPaths, ...adminPaths, "/unknown"])(
    "returns anonymous 401 for %s, not a handler response or 404",
    async (path) => {
      const res = await request(app).get(`/api${path}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Sign in to continue." });
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(provider.getUser).not.toHaveBeenCalled();
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it("ignores forged identity, role and bearer headers on anonymous requests", async () => {
    const res = await request(app).get("/api/settings/access")
      .set("X-User-Id", "user_forged").set("X-Role", "admin")
      .set("X-App-Role", "admin").set("Authorization", "Bearer forged-not-a-token");
    expect(res.status).toBe(401);
    expect(provider.getUser).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "administrator", "ADMIN", "", {}, ["admin"], true, 1])(
    "does not coerce an invalid server-owned role (%j)", (role) => {
      expect(appRole(role)).toBe("unassigned");
    },
  );

  it("exposes an unassigned session but denies reports and settings", async () => {
    signIn("unassigned");
    const session = await request(app).get("/api/auth/session");
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      userId: "user_isolated_a", role: "unassigned", canReport: false, canAdminister: false,
    });
    for (const path of [...reportPaths, ...adminPaths, "/settings/access", "/unknown"]) {
      expect((await request(app).get(`/api${path}`)).status).toBe(403);
    }
    expect(reached).not.toHaveBeenCalled();
  });

  it("never promotes unsafe metadata, stale session claims, headers or request bodies", async () => {
    signIn("unassigned", { unsafeMetadata: { role: "admin", canAdminister: true } });
    provider.claims = { role: "admin", publicMetadata: { role: "admin" }, metadata: { role: "admin" } };
    const res = await mutation("post").set("Origin", "https://wareiq.test")
      .set("X-Role", "admin").set("X-User-Id", "user_forged")
      .send({ role: "admin", publicMetadata: { role: "admin" } });
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
    expect(provider.getUser).toHaveBeenCalledWith("user_isolated_a");
    expect((await request(app).get("/api/auth/session")).body.role).toBe("unassigned");
  });

  it("allows supervisor reporting, but denies every administrator prefix", async () => {
    signIn("supervisor");
    for (const path of reportPaths) {
      expect((await request(app).get(`/api${path}`)).body).toEqual({ role: "supervisor" });
    }
    reached.mockClear();
    for (const path of [...adminPaths, "/settings/access", "/settings/nested/future-export"]) {
      expect((await request(app).get(`/api${path}`)).status).toBe(403);
    }
    expect(reached).not.toHaveBeenCalled();
  });

  it("allows administrators through reporting, settings, config, connection and admin guards", async () => {
    signIn();
    for (const path of [...reportPaths, ...adminPaths]) {
      const res = await request(app).get(`/api${path}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ role: "admin" });
    }
    expect((await request(app).get("/api/settings/access")).body).toEqual({ canAdminister: true });
    expect((await request(app).get("/api/unknown")).status).toBe(404);
  });

  it("reads the current role on each request after downgrade and full revocation", async () => {
    signIn();
    provider.claims = { role: "admin" }; // deliberately stale throughout
    expect((await request(app).get("/api/settings/access")).status).toBe(200);
    provider.getUser.mockResolvedValue(account("supervisor"));
    expect((await request(app).get("/api/settings/access")).status).toBe(403);
    expect((await request(app).get("/api/reports/regression")).status).toBe(200);
    provider.getUser.mockResolvedValue(account("unassigned"));
    expect((await request(app).get("/api/reports/regression")).status).toBe(403);
    expect(provider.getUser).toHaveBeenCalledTimes(4);
  });

  it.each(["banned", "locked"])("denies a currently %s administrator", async (flag) => {
    signIn("admin", { [flag]: true });
    expect((await request(app).get("/api/auth/session")).status).toBe(403);
    expect((await request(app).get("/api/reports/regression")).status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it("fails closed on provider failure, including after an allowed request, without leaking errors", async () => {
    signIn();
    expect((await request(app).get("/api/settings/access")).status).toBe(200);
    provider.getUser.mockRejectedValue(new Error("sensitive-provider-detail"));
    for (const path of ["/auth/session", "/settings/access", ...reportPaths]) {
      const res = await request(app).get(`/api${path}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Unable to verify access. Try again shortly." });
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
    expect(reached).not.toHaveBeenCalled();
    expect(provider.warn).toHaveBeenCalledWith("Unable to verify account permissions");
    expect(JSON.stringify(provider.warn.mock.calls)).not.toContain("sensitive-provider-detail");
  });

  it.each([requireReporter, requireAdministrator])("denies when identity middleware has not supplied access", async (guard) => {
    const isolated = express();
    isolated.get("/", guard, (_req, res) => res.sendStatus(200));
    expect((await request(isolated).get("/")).status).toBe(403);
  });

  it("does not reuse the previous identity after sign-out or an account switch", async () => {
    signIn();
    expect((await request(app).get("/api/settings/access")).status).toBe(200);
    provider.userId = null;
    expect((await request(app).get("/api/settings/access")).status).toBe(401);
    provider.userId = "user_isolated_b";
    provider.getUser.mockResolvedValue(account("unassigned"));
    expect((await request(app).get("/api/settings/access")).status).toBe(403);
    expect(provider.getUser).toHaveBeenLastCalledWith("user_isolated_b");
  });
});

describe("application same-origin mutation enforcement", () => {
  beforeEach(() => signIn());

  it.each(["post", "put", "patch", "delete"] as const)("allows a same-origin %s to reach authorized handlers", async (method) => {
    const res = await mutation(method).set("Origin", "https://wareiq.test").set("Sec-Fetch-Site", "same-origin");
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledOnce();
  });

  it.each([
    undefined, "null", "not a url", "https://evil.test", "https://wareiq.test.evil.test",
    "https://wareiq.test:444", "http://wareiq.test", "ftp://wareiq.test",
    "https://user:password@wareiq.test", "https://wareiq.test/path",
  ])(
    "denies mutations with absent, malformed or foreign origin %s before checking roles", async (origin) => {
      let req = mutation("post");
      if (origin !== undefined) req = req.set("Origin", origin);
      const res = await req;
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "A same-origin request is required." });
      expect(provider.getUser).not.toHaveBeenCalled();
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-site fetch metadata even when Origin matches", async () => {
    expect((await mutation("post").set("Origin", "https://wareiq.test").set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it("uses the public proxy hostname, not the internal service hostname", async () => {
    const res = await mutation("post").set("Host", "internal.test")
      .set("X-Forwarded-Host", "wareiq.test, internal.test").set("Origin", "https://wareiq.test");
    expect(res.status).toBe(200);
    const denied = await mutation("post").set("Host", "internal.test")
      .set("X-Forwarded-Host", "wareiq.test").set("Origin", "https://internal.test");
    expect(denied.status).toBe(403);
  });

  it("supports direct same-origin requests without forwarded headers", async () => {
    const res = await request(app).post("/api/settings/regression")
      .set("Host", "wareiq.test").set("Origin", "http://wareiq.test");
    expect(res.status).toBe(200);
  });

  it("does not offer cross-origin API reads or preflight permission", async () => {
    const res = await request(app).get("/api/auth/session").set("Origin", "https://evil.test");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await request(app).options("/api/settings/regression")
      .set("Origin", "https://evil.test").set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("membership-based routes mounted ahead of legacy guards", () => {
  it("only exposes a signed-out summary from the intentionally public membership endpoint", async () => {
    const summary = await request(app).get("/api/access/me");
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ status: "signed_out", platformAdmin: false, reportIds: [], sites: [] });
    expect(provider.getUser).not.toHaveBeenCalled();
    expect((await request(app).get("/api/access/admin")).status).toBe(401);
    expect((await request(app).get("/api/access/own-reports")).status).toBe(401);
  });

  it("does not let a global supervisor claim bypass client membership approval", async () => {
    signIn("supervisor");
    const summary = await request(app).get("/api/access/me");
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ status: "unassigned", platformAdmin: false, reportIds: [] });
    expect((await request(app).get("/api/access/admin")).status).toBe(403);
    expect((await request(app).get("/api/access/own-reports")).status).toBe(403);
    expect((await mutation("post", "/api/access/reports/isolated-report/run")
      .set("Origin", "https://wareiq.test").send({ siteId: "isolated-site" })).status).toBe(403);
  });

  it("uses trusted current metadata, never unsafe metadata or stale claims, for platform administration", async () => {
    signIn("unassigned", { unsafeMetadata: { role: "admin" } });
    provider.claims = { role: "admin", publicMetadata: { role: "admin" } };
    expect((await request(app).get("/api/access/admin").set("X-Role", "admin")).status).toBe(403);
    const summary = await request(app).get("/api/access/me");
    expect(summary.body.platformAdmin).toBe(false);
    provider.getUser.mockResolvedValue(account("admin"));
    expect((await request(app).get("/api/access/me")).body.platformAdmin).toBe(true);
    provider.getUser.mockResolvedValue(account("unassigned"));
    expect((await request(app).get("/api/access/me")).body.platformAdmin).toBe(false);
    provider.getUser.mockRejectedValue(new Error("sensitive-provider-detail"));
    const failed = await request(app).get("/api/access/me");
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("sensitive-provider-detail");
  });
});
