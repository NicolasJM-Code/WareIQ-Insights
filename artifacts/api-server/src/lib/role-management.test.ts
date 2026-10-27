import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AccessConflict, accessUser, changeRole } from "./role-management";
import { appRole } from "./access-policy";
import { ChangeAccessRoleBody } from "@workspace/api-zod";

type Directory = Parameters<typeof changeRole>[0];
type User = Awaited<ReturnType<Directory["getUser"]>>;

function user(id: string, role = "unassigned", verified = true): User {
  return {
    id, firstName: "Test", lastName: "Account", primaryEmailAddressId: `${id}-email`,
    emailAddresses: [{ id: `${id}-email`, emailAddress: `${id}@example.test`, verification: { status: verified ? "verified" : "unverified" } }],
    publicMetadata: { role, unrelated: "preserved" }, banned: false, locked: false,
  } as unknown as User;
}
function directory(records: User[]) {
  const writes: unknown[] = [];
  const api = {
    getUser: async (id: string) => {
      const found = records.find((u) => u.id === id);
      if (!found) throw { status: 404 };
      return found;
    },
    getUserList: async ({ offset = 0, limit = 100 } = {}) => ({
      data: records.slice(offset, offset + limit), totalCount: records.length,
    }),
    updateUserMetadata: async (id: string, body: { publicMetadata: { role: string } }) => {
      writes.push(body);
      const current = records.find((u) => u.id === id)!;
      Object.assign(current.publicMetadata, body.publicMetadata);
      return current;
    },
  } satisfies Partial<Directory>;
  return { api: api as Directory, writes };
}
function conflict(status: number) {
  return (error: unknown) => error instanceof AccessConflict && error.status === status;
}

test("approval, role change, and revocation preserve unrelated metadata and return only safe fields", async () => {
  const records = [user("actor", "admin"), user("target")];
  const { api } = directory(records);
  assert.equal((await changeRole(api, "actor", "target", "supervisor", "unassigned")).role, "supervisor");
  assert.equal((await changeRole(api, "actor", "target", "admin", "supervisor")).role, "admin");
  assert.equal((await changeRole(api, "actor", "target", "unassigned", "admin")).role, "unassigned");
  assert.equal(records[1].publicMetadata.unrelated, "preserved");
  assert.deepEqual(Object.keys(accessUser(records[1])).sort(), ["email", "emailVerified", "id", "name", "restricted", "role"]);
});

test("non-administrators and revoked/locked/unverified actors cannot mutate", async () => {
  for (const actor of [user("actor", "supervisor"), user("actor"), Object.assign(user("actor", "admin"), { locked: true }), user("actor", "admin", false)]) {
    const { api, writes } = directory([actor, user("target")]);
    await assert.rejects(changeRole(api, "actor", "target", "admin", "unassigned"), conflict(403));
    assert.equal(writes.length, 0);
  }
});

test("self-role changes are rejected, including last administrator demotion", async () => {
  const { api, writes } = directory([user("actor", "admin")]);
  for (const role of ["supervisor", "unassigned", "admin"] as const) {
    await assert.rejects(changeRole(api, "actor", "actor", role, "admin"), conflict(409));
  }
  assert.equal(writes.length, 0);
});

test("unverified and restricted accounts cannot receive grants but can be revoked", async () => {
  for (const target of [user("target", "supervisor", false), Object.assign(user("target", "supervisor"), { banned: true })]) {
    const { api } = directory([user("actor", "admin"), target]);
    await assert.rejects(changeRole(api, "actor", "target", "admin", "supervisor"), conflict(403));
    assert.equal((await changeRole(api, "actor", "target", "unassigned", "supervisor")).role, "unassigned");
  }
});

test("stale confirmations cannot overwrite another administrator's role change", async () => {
  const { api, writes } = directory([user("actor", "admin"), user("target", "supervisor")]);
  await assert.rejects(changeRole(api, "actor", "target", "admin", "unassigned"), conflict(409));
  assert.equal(writes.length, 0);
});

test("administrator scan includes later pages", async () => {
  const records = [user("target", "admin"), ...Array.from({ length: 105 }, (_, i) => user(`pending-${i}`)), user("actor", "admin")];
  const { api } = directory(records);
  assert.equal((await changeRole(api, "actor", "target", "unassigned", "admin")).role, "unassigned");
});

test("last active administrator is protected if another administrator disappears during verification", async () => {
  const target = user("target", "admin");
  const actor = user("actor", "admin");
  const { api, writes } = directory([target]);
  api.getUser = async (id) => id === "actor" ? actor : target;
  await assert.rejects(changeRole(api, "actor", "target", "unassigned", "admin"), conflict(409));
  assert.equal(writes.length, 0);
});

test("provider failures fail closed before writing", async () => {
  const { api, writes } = directory([user("actor", "admin"), user("target", "admin")]);
  api.getUserList = async () => { throw new Error("Provider unavailable"); };
  await assert.rejects(changeRole(api, "actor", "target", "supervisor", "admin"));
  assert.equal(writes.length, 0);
});

test("unknown roles fail closed and mutation contract rejects extra or missing fields", () => {
  assert.equal(appRole("owner"), "unassigned");
  assert.equal(ChangeAccessRoleBody.strict().safeParse({ role: "owner", expectedRole: "unassigned" }).success, false);
  assert.equal(ChangeAccessRoleBody.strict().safeParse({ role: "admin" }).success, false);
  assert.equal(ChangeAccessRoleBody.strict().safeParse({ role: "admin", expectedRole: "unassigned", userId: "other" }).success, false);
});
