# WareIQ access operations

WareIQ uses Replit-managed Clerk, not application-managed passwords. New accounts
have no reporting access. The first signup is **not** automatically an administrator.
Trusted Clerk `admin` metadata grants platform administration. Reporting users are
approved by verified email in **User access**, assigned to one client, a client-specific
role, and one or more imported WMS sites. Own-report creation is a separate permission.
The former global `supervisor` role does not bypass these client/site assignments.

## Establish the first administrator or change a role

1. Have the intended person sign up in WareIQ and verify their email.
2. Verify that this person owns the account and is authorized for the role.
3. From the trusted workspace terminal, run:

   ```sh
   pnpm --filter @workspace/scripts wareiq:role --email <verified-email> --role admin --confirm-ownership
   ```

   Use User access to approve or disable reporting users and change their roles.
   Use `unassigned` here to remove platform administrator rights. Removing those
   rights does not delete any separately approved client membership; disable that
   membership as well when all reporting access must be revoked.
   The command preserves unrelated metadata and skips unchanged grants. It is
   an explicit manual action, never a startup seed that could restore revoked
   privileges. Do not pass secret keys on the command line.

4. Sign in and verify the role in the account header. Administrators can open
   Settings. Supervisors receive Access denied if they navigate there directly.
   The next API request checks the new role; the open UI refreshes permissions
   every 30 seconds and on window focus.

Development and production have separate Clerk identities. Run this command in
the appropriate trusted target environment using that environment's managed
credentials; live changes additionally require `--confirm-production`. Never
copy production credentials into the workspace. No production role is created
by running the command in development.

## Enforcement and boundaries

- `/api/healthz` is public. The Clerk frontend proxy is mounted separately.
- All other API routes require verified identity by default.
- `/api/settings`, `/api/config`, `/api/connection`, and `/api/admin` require
  administrator access before any route handler runs.
- Remaining reporting endpoints require supervisor or administrator access.
  Register new reporting handlers **after** the existing central guards. Mount
  connection/configuration handlers under the administrator prefixes above.
  The access router is mounted before the generic fallback guard because its
  `/access/me` endpoint describes signed-out status. Every other access operation
  authenticates and authorizes internally; never add an unguarded operation there.
- Platform administration comes from current Clerk **public metadata**, retrieved
  server-side on each request, not client headers or stale token role claims.
  Client reporting grants come from active application-database membership and
  roles. Provider failures deny access. Role-edit APIs require platform administration.
- Cookie-authenticated mutation requests require a matching Origin. CORS is
  not enabled for third-party browser clients.
- Never return WMS passwords, usernames, connection strings, or raw database
  errors. Role checks do not make returning credentials safe.
- Own-report definitions are private to a verified account and client in the
  application database. Browser storage holds only per-user preferences. Legacy
  local report definitions remain untouched and are not automatically imported.
- Logout uses Clerk's session revocation, returns to the public landing page,
  clears cached queries, and unmounts reporting state when the identity changes.

Site and report permissions are enforced server-side. Users may be approved as
pending without sites, but cannot run reports until real WMS sites are imported
and assigned. Live report mappings, schedules, alerts and durable audit history
are not implemented.

## WMS credential destination approval

Connection tests never send credentials to an arbitrary administrator-entered host.
The server must have a valid matching PostgreSQL `WMS_DATABASE_URL`, or a
`WMS_PGPASSWORD` plus all four server-only settings: `WMS_APPROVED_HOST`,
`WMS_APPROVED_PORT`, `WMS_APPROVED_DATABASE`, `WMS_APPROVED_USERNAME`.
Explicit approval settings must be complete; mismatches and missing approval
fail before DNS lookup or creating a PostgreSQL pool. Changing browser fields
does not approve a new endpoint. Owners must make destination changes securely
on the server; do not disable TLS verification to make a test pass.
