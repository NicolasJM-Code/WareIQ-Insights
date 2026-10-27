# WareIQ access operations

WareIQ uses Replit-managed Clerk, not application-managed passwords. The only
application roles are `admin`, `supervisor`, and `unassigned`. All new accounts
are unassigned. The first person to sign up is **not** automatically an admin.

## Establish the first administrator or change a role

1. Have the intended person sign up in WareIQ and verify their email.
2. Verify that this person owns the account and is authorized for the role.
3. From the trusted workspace terminal, run:

   ```sh
   pnpm --filter @workspace/scripts wareiq:role --email <verified-email> --role admin --confirm-ownership
   ```

   Use `supervisor` for reporting-only access or `unassigned` to revoke access.
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
  Never mount a new router ahead of the guards to make it work.
- Roles come from current Clerk **public metadata**, retrieved server-side on
  each request, not client headers, unsafe metadata, or stale token role claims.
  Provider failures deny access. The application exposes no role-edit API.
- Cookie-authenticated mutation requests require a matching Origin. CORS is
  not enabled for third-party browser clients.
- Never return WMS passwords, usernames, connection strings, or raw database
  errors. Role checks do not make returning credentials safe.
- Browser storage contains only per-user demo report definitions and preferences,
  not operational records or secrets. Old unowned demo definitions are left
  untouched and are not assigned to a new account automatically.
- Logout uses Clerk's session revocation, returns to the public landing page,
  clears cached queries, and unmounts reporting state when the identity changes.

This access layer does not create a WMS connection, implement site-level
permissions, schedules, alerts, or durable audit logging.
