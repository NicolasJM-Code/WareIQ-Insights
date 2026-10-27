import type { createClerkClient } from "@clerk/backend";
import type { AccessAuditStore, AuditRole } from "@workspace/db/access-audit-types";

const usage = "Usage: pnpm --filter @workspace/scripts wareiq:role --email <verified-email> --role admin|supervisor|unassigned --operator-id <stable-non-personal-id> --confirm-ownership [--confirm-production]";
export function parseRoleCommand(args: string[], production: boolean) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (["--confirm-ownership", "--confirm-production"].includes(name)) {
      if (flags.has(name)) throw new Error(usage);
      flags.add(name);
    } else if (["--email", "--role", "--operator-id"].includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || values.has(name)) throw new Error(usage);
      values.set(name, value);
    } else throw new Error(usage);
  }
  const email = values.get("--email")?.trim().toLowerCase();
  const role = values.get("--role");
  const operator = values.get("--operator-id");
  if (!email || !["admin", "supervisor", "unassigned"].includes(role ?? "") ||
      !operator || !/^[a-z][a-z0-9_-]{2,63}$/.test(operator) || !flags.has("--confirm-ownership")) {
    throw new Error(usage);
  }
  if (production && !flags.has("--confirm-production")) {
    throw new Error("Production changes also require --confirm-production in the target production environment.");
  }
  return { email, role: role as AuditRole, actorId: `operator:${operator}` };
}

type Directory = ReturnType<typeof createClerkClient>["users"];
type CommandStore = AccessAuditStore & { target: (id: string, targetId: string) => Promise<void> };
class CommandDenied extends Error {}
const normalizedRole = (role: unknown): AuditRole =>
  role === "admin" || role === "supervisor" ? role : "unassigned";

// Emergency owner override, intentionally not the Settings administrator policy:
// it can establish the first admin and recover the last admin's account.
export async function runRoleCommand(
  input: ReturnType<typeof parseRoleCommand>,
  users: Pick<Directory, "getUserList" | "getUser" | "updateUserMetadata">,
  store: CommandStore,
  lock: <T>(operation: () => Promise<T>) => Promise<T>,
) {
  const id = await store.start({ actorId: input.actorId, targetId: null, requestedRole: input.role });
  let writeAttempted = false;
  try {
    await lock(async () => {
      const matches = await users.getUserList({ emailAddress: [input.email] });
      const exact = matches.data.filter((user) => user.emailAddresses.some((email) =>
        email.emailAddress.toLowerCase() === input.email && email.verification?.status === "verified"));
      if (exact.length !== 1 || !/^user_[a-zA-Z0-9_]{1,195}$/.test(exact[0].id)) throw new CommandDenied();
      await store.target(id, exact[0].id);
      // Recheck after resolution and under the same lock as Settings.
      const target = await users.getUser(exact[0].id);
      if (target.id !== exact[0].id || !target.emailAddresses.some((email) =>
        email.emailAddress.toLowerCase() === input.email && email.verification?.status === "verified")) {
        throw new CommandDenied();
      }
      const previous = normalizedRole(target.publicMetadata.role);
      await store.previous(id, previous);
      if (target.banned || target.locked) throw new CommandDenied();
      if (target.publicMetadata.role === input.role) return;
      writeAttempted = true;
      const updated = await users.updateUserMetadata(target.id, { publicMetadata: { role: input.role } });
      if (updated.id !== target.id || updated.publicMetadata.role !== input.role) throw new Error();
    });
  } catch (error) {
    await store.finish(id, writeAttempted ? "unconfirmed" : error instanceof CommandDenied ? "denied" : "failed",
      writeAttempted ? "provider_outcome_unknown" : error instanceof CommandDenied ? "command_target_ineligible" : "change_not_started");
    throw new Error(writeAttempted
      ? "Role outcome is unconfirmed. Check access history and current permissions before retrying."
      : "Role change not attempted. Check the verified target account and application audit database.");
  }
  await store.finish(id, writeAttempted ? "succeeded" : "unchanged",
    writeAttempted ? "role_confirmed" : "already_assigned", input.role);
  return { id, changed: writeAttempted };
}
