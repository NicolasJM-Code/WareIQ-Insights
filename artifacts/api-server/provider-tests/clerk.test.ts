import { expect, it, vi } from "vitest";
import request from "supertest";
import { clerkClient } from "@clerk/express";
import { provider, runProviderCheck, type Manifest } from "./harness";

// Real Clerk middleware, key selection, getAuth, user and session APIs.
// Only application data/logging are isolated. No WMS or application pool opens.
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
}));
vi.mock("../src/lib/logger", () => ({
  logger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {}, level: "silent" }) },
}));
vi.mock("pino-http", () => ({
  default: () => (req: { log: unknown }, _res: unknown, next: () => void) => {
    req.log = { warn() {}, error() {} };
    next();
  },
}));

let manifest: Manifest | undefined;
let app: typeof import("../src/app").default;
const probePath = "/api/reports/provider-integration";
let reached = 0;

async function token() {
  const session = await provider("fresh development session creation", () =>
    clerkClient.sessions.createSession({ userId: manifest!.userId }));
  const result = await provider("session token minting", () => clerkClient.sessions.getToken(session.id));
  return { sessionId: session.id, jwt: result.jwt };
}
async function allowed(jwt: string) {
  const report = await request(app).get(probePath).set("Authorization", `Bearer ${jwt}`);
  expect(report.status).toBe(200);
  expect(report.body.permitted).toBe(true);
  const summary = await request(app).get("/api/access/me").set("Authorization", `Bearer ${jwt}`);
  expect(summary.status).toBe(200);
  expect(summary.body.status).toBe("active");
  expect(summary.body.platformAdmin).toBe(true);
  expect(summary.body.reportIds.length).toBeGreaterThan(0);
}
async function denied(jwt: string) {
  const before = reached;
  for (const path of [probePath, "/api/auth/session", "/api/access/own-reports"]) {
    const response = await request(app).get(path).set("Authorization", `Bearer ${jwt}`);
    expect(response.status).toBe(401);
  }
  const summary = await request(app).get("/api/access/me").set("Authorization", `Bearer ${jwt}`);
  expect([200, 401]).toContain(summary.status);
  if (summary.status === 200) {
    expect(summary.body.status).toBe("signed_out");
    expect(summary.body.platformAdmin).toBe(false);
    expect(summary.body.reportIds).toEqual([]);
  }
  expect(reached).toBe(before);
}

async function checkTokens(fixture: Manifest) {
  manifest = fixture;
  app = (await import("../src/app")).default;
  const router = (await import("../src/routes")).default;
  router.get("/reports/provider-integration", (_req, res) => {
    reached++;
    res.json({ permitted: true });
  });
  await denied("not-a-jwt");
  const first = await token();
  await allowed(first.jwt);
  const parts = first.jwt.split(".");
  // Change the first signature byte, not padding bits; claims remain untouched.
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  await denied(parts.join("."));

  // Natural expiry of a REAL signed token, not a forged exp claim or fake clock.
  const claims = JSON.parse(Buffer.from(first.jwt.split(".")[1], "base64url").toString()) as { exp: number };
  const wait = claims.exp * 1000 - Date.now() + 6_000; // Clerk clock-skew allowance.
  if (!Number.isFinite(wait) || wait < 0 || wait > 130_000)
    throw new Error("Unexpected development token lifetime; refusing an unbounded expiry wait.");
  await new Promise((done) => setTimeout(done, wait));
  await denied(first.jwt);

  const revoked = await token();
  await allowed(revoked.jwt);
  await provider("session revocation", () => clerkClient.sessions.revokeSession(revoked.sessionId));
  const revokedClaims = JSON.parse(Buffer.from(revoked.jwt.split(".")[1], "base64url").toString()) as { exp: number };
  // A slow provider must not turn this into another expiry test.
  expect(revokedClaims.exp * 1000 - Date.now()).toBeGreaterThan(10_000);
  await denied(revoked.jwt); // Replay immediately, while JWT is still unexpired.
  const fresh = await token();
  await allowed(fresh.jwt);
}

it("rejects malformed, tampered, expired and revoked tokens, then allows a fresh session", async () => {
  await runProviderCheck(process.env, { users: clerkClient.users }, checkTokens);
});
