import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";

const fixtures = vi.hoisted(() => ({
  userId: "user_admin",
  role: "admin",
  email: "admin@example.test",
  select: vi.fn(),
  update: vi.fn(),
  fetch: vi.fn(),
  getMetadata: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: fixtures.userId }),
  clerkClient: { users: { getUser: vi.fn(async () => ({
    banned: false,
    locked: false,
    primaryEmailAddressId: "email_primary",
    emailAddresses: [{
      id: "email_primary",
      emailAddress: fixtures.email,
      verification: { status: "verified" },
    }],
    publicMetadata: { role: fixtures.role },
  })) } },
}));

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return {
    ...schema,
    db: { select: fixtures.select, update: fixtures.update },
  };
});

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file: () => ({
          getMetadata: fixtures.getMetadata,
          createReadStream: fixtures.createReadStream,
        }),
      };
    }
  },
}));

import { clientsTable, membersTable, rolesTable, sitesTable } from "@workspace/db";
import accessRouter from "../src/routes/access";

const clientAId = "3ed2c922-b996-44e4-8d9f-929d522026b2";
const clientBId = "61f1fc93-e6a9-4e9d-822d-d8663cfe5a18";
const logoAPath = `/objects/client-logos/${clientAId}/9fa7be17-1a8f-4e13-9a21-f8083878b404.png`;
const clientA = {
  id: clientAId, name: "Client A", companyNumber: "A-1",
  addressLine1: "1 Main St", addressLine2: "", city: "Town", region: "",
  postalCode: "", country: "US", active: true, logoPath: logoAPath,
};
const clientB = { ...clientA, id: clientBId, name: "Client B", logoPath: null };
const role = { id: "role_a", clientId: clientAId, reportIds: [], canCreateOwnReports: false };
const memberA = {
  id: "member_a", clientId: clientAId, roleId: role.id,
  email: "admin@example.test", active: true, siteIds: [],
};
const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.log = { error: vi.fn(), warn: vi.fn() } as unknown as typeof req.log;
  next();
});
app.use(accessRouter);

function queryRows(table: unknown) {
  if (table === membersTable) return [memberA];
  if (table === rolesTable) return [role];
  if (table === sitesTable) return [];
  if (table === clientsTable) return [clientA, clientB];
  return [];
}

function configureDatabase() {
  fixtures.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async () => queryRows(table),
    }),
  }));
  fixtures.update.mockImplementation(() => ({
    set: (values: Partial<typeof clientA>) => ({
      where: () => ({
        returning: async () => [{ ...clientA, ...values }],
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PRIVATE_OBJECT_DIR = "test-private-bucket/private";
  vi.stubGlobal("fetch", fixtures.fetch);
  fixtures.userId = "user_admin";
  fixtures.role = "admin";
  fixtures.email = "admin@example.test";
  configureDatabase();
  fixtures.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ signed_url: "https://storage.example.test/signed-upload" }),
  });
  fixtures.getMetadata.mockResolvedValue([{ contentType: "image/png", size: 1200 }]);
  fixtures.createReadStream.mockImplementation(() => Readable.from([Buffer.from("logo-bytes")]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
});

describe("client logo routes", () => {
  it.each(["supervisor", "unassigned"])("%s cannot request a signed logo upload", async (role) => {
    fixtures.role = role;
    const response = await request(app)
      .post(`/access/clients/${clientAId}/logo-upload`)
      .send({ name: "logo.png", size: 1200, contentType: "image/png" });

    expect(response.status).toBe(403);
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.select).not.toHaveBeenCalled();
  });

  it.each([
    { name: "bad mime type", body: { name: "logo.svg", size: 1200, contentType: "image/svg+xml" } },
    { name: "oversized file", body: { name: "logo.png", size: 2 * 1024 * 1024 + 1, contentType: "image/png" } },
  ])("rejects $name before requesting an upload URL", async ({ body }) => {
    const response = await request(app)
      .post(`/access/clients/${clientAId}/logo-upload`)
      .send(body);

    expect(response.status).toBe(400);
    expect(fixtures.fetch).not.toHaveBeenCalled();
  });

  it("allows an administrator to request a client-scoped upload", async () => {
    const response = await request(app)
      .post(`/access/clients/${clientAId}/logo-upload`)
      .send({ name: "logo.png", size: 1200, contentType: "image/png" });

    expect(response.status).toBe(200);
    expect(response.body.uploadURL).toBe("https://storage.example.test/signed-upload");
    expect(response.body.objectPath).toMatch(new RegExp(`^/objects/client-logos/${clientAId}/[0-9a-f-]+\\.png$`));
    expect(fixtures.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fixtures.fetch.mock.calls[0][1].body).object_name).toMatch(
      new RegExp(`^private/client-logos/${clientAId}/[0-9a-f-]+\\.png$`),
    );
  });

  it("rejects a non-admin trying to save a logo", async () => {
    fixtures.role = "supervisor";
    const response = await request(app)
      .put(`/access/clients/${clientAId}/logo`)
      .send({ objectPath: logoAPath });

    expect(response.status).toBe(403);
    expect(fixtures.update).not.toHaveBeenCalled();
  });

  it("rejects cross-client paths without checking storage or saving", async () => {
    const response = await request(app)
      .put(`/access/clients/${clientBId}/logo`)
      .send({ objectPath: logoAPath });

    expect(response.status).toBe(400);
    expect(fixtures.getMetadata).not.toHaveBeenCalled();
    expect(fixtures.update).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing object", reject: true, contentType: "image/png", size: 1200 },
    { name: "unsupported object mime type", reject: false, contentType: "image/svg+xml", size: 1200 },
    { name: "oversized object", reject: false, contentType: "image/png", size: 2 * 1024 * 1024 + 1 },
  ])("does not save a $name", async ({ reject, contentType, size }) => {
    if (reject) fixtures.getMetadata.mockRejectedValue(new Error("object not found"));
    else fixtures.getMetadata.mockResolvedValue([{ contentType, size }]);

    const response = await request(app)
      .put(`/access/clients/${clientAId}/logo`)
      .send({ objectPath: logoAPath });

    expect(response.status).toBe(400);
    expect(fixtures.getMetadata).toHaveBeenCalledOnce();
    expect(fixtures.update).not.toHaveBeenCalled();
  });

  it("lets an administrator save a verified logo", async () => {
    const response = await request(app)
      .put(`/access/clients/${clientAId}/logo`)
      .send({ objectPath: logoAPath });

    expect(response.status).toBe(200);
    expect(response.body.logoPath).toBe(logoAPath);
    expect(fixtures.getMetadata).toHaveBeenCalledOnce();
    expect(fixtures.update).toHaveBeenCalledOnce();
  });

  it("denies a user from another client before reading the private logo", async () => {
    fixtures.role = "supervisor";
    fixtures.email = "member-b@example.test";
    fixtures.select.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: async () => table === membersTable
          ? [{ ...memberA, clientId: clientBId, email: fixtures.email }]
          : table === clientsTable
            ? [clientB]
            : table === rolesTable
              ? [{ ...role, clientId: clientBId }]
              : [],
      }),
    }));

    const response = await request(app).get(`/access/clients/${clientAId}/logo`);

    expect(response.status).toBe(403);
    expect(fixtures.getMetadata).not.toHaveBeenCalled();
  });

  it.each(["member", "client"])("denies logo access when the %s is disabled", async (disabled) => {
    fixtures.role = "supervisor";
    fixtures.select.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: async () => table === membersTable
          ? [{ ...memberA, active: disabled !== "member" }]
          : table === clientsTable
            ? [{ ...clientA, active: disabled !== "client" }]
            : table === rolesTable
              ? [role]
              : [],
      }),
    }));

    const response = await request(app).get(`/access/clients/${clientAId}/logo`);

    expect(response.status).toBe(403);
    expect(fixtures.getMetadata).not.toHaveBeenCalled();
  });

  it("serves a private logo only to an authorized client member", async () => {
    fixtures.role = "supervisor";
    const response = await request(app).get(`/access/clients/${clientAId}/logo`);

    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).toString()).toBe("logo-bytes");
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["content-disposition"]).toBe("inline");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(fixtures.getMetadata).toHaveBeenCalledOnce();
  });

  it("returns not found when the private logo object is missing", async () => {
    fixtures.getMetadata.mockRejectedValue(new Error("object not found"));
    const response = await request(app).get(`/access/clients/${clientAId}/logo`);

    expect(response.status).toBe(404);
    expect(fixtures.getMetadata).toHaveBeenCalledOnce();
  });

  it("does not read a stored logo path belonging to another client", async () => {
    fixtures.select.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: async () => table === membersTable
          ? [memberA]
          : table === rolesTable
            ? [role]
            : table === clientsTable
              ? [{ ...clientA, logoPath: logoAPath.replace(clientAId, clientBId) }, clientB]
              : [],
      }),
    }));
    fixtures.role = "supervisor";

    const response = await request(app).get(`/access/clients/${clientAId}/logo`);

    expect(response.status).toBe(404);
    expect(fixtures.getMetadata).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "image/svg+xml", size: 1200 },
    { contentType: "image/png", size: 2 * 1024 * 1024 + 1 },
    { contentType: "image/png", size: 0 },
  ])("does not serve unsupported or invalid object metadata: %j", async (metadata) => {
    fixtures.getMetadata.mockResolvedValue([{ contentType: metadata.contentType, size: metadata.size }]);
    const response = await request(app).get(`/access/clients/${clientAId}/logo`);

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).not.toContain("image/");
  });
});
