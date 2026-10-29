# WareIQ access operations

WareIQ uses Replit-managed Clerk, not application-managed passwords. New accounts
have no reporting access. The first signup is **not** automatically an administrator.
Trusted Clerk `admin` metadata grants platform administration. Reporting users are
approved by verified email in **User access**, assigned to one client, a client-specific
role, and one or more explicitly assigned warehouses. Own-report creation is a separate permission.
The former global `supervisor` role does not bypass these client/site assignments.

## Establish the first administrator

1. Have the intended person sign up in WareIQ and verify their email.
2. Verify that this person owns the account and is authorized for the role.
3. From the trusted workspace terminal, run:

   ```sh
   pnpm --filter @workspace/scripts wareiq:role --email <verified-email> --role admin --operator-id <stable-non-personal-id> --confirm-ownership
   ```

   Use User access to approve or disable reporting users and change their roles.
   After bootstrap, use Settings → Users & administration for platform role changes.
   The command remains a trusted emergency recovery override and now shares
   Settings' application-database role lock. Never edit Clerk metadata concurrently
   with application role administration; dashboard writes do not take that lock.
   Use `unassigned` here to remove platform administrator rights. Removing those
   rights does not delete any separately approved client membership; disable that
   membership as well when all reporting access must be revoked.
   The command requires the target environment's application `DATABASE_URL`
   and writes access history before contacting Clerk. Choose a stable, non-personal
   operator alias (3–64 lowercase letters/digits/underscores/hyphens, starting with
   a letter), not an email, name, secret, or Clerk user ID. The terminal operator
   attests this identifier; it is not proof of an authenticated app administrator.
   Keep the alias-to-operator mapping in the owner's separate trusted operations
   records. See `docs/access-change-history.md` for evidence and uncertainty limits.
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

## Approve reporting access and platform administrators

- **User access** manages client reporting approval: configure the client,
  warehouses and reporting role, then approve the verified login email and
  explicitly assigned warehouses. Disable its membership to revoke reporting.
- **Settings → Users & administration → Platform administrator approval** lists
  Clerk accounts, newest first, with pagination and verification/restriction
  status. Confirm grants of Administrator or removal of a platform role here.
  An account without a platform role may still have separately approved client
  reporting access. The legacy global Supervisor role alone grants no client
  access and is not offered as a reporting approval action.
- Platform approvals require a verified primary email and unrestricted account.
  Administrators cannot change their own role or remove the last usable
  administrator. Stale confirmations conflict instead of overwriting newer roles.
- Platform changes are serialized across API instances by a PostgreSQL advisory
  lock in the application database, never the WMS. The actor is checked again
  inside the lock. No additional access table migration is required for this lock.
- Removing platform privileges does **not** disable client reporting membership.
  Disable that membership in User access as well when all access must be revoked.
  Each API request checks current privileges; open screens poll and refresh on
  focus. Previously viewed or downloaded information cannot be recalled.

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
  `/api/admin/users` and `/api/admin/users/:userId/role` are guarded administrator
  endpoints returning only account identity, verification/restriction status,
  and platform role, never Clerk metadata or credentials.
- Cookie-authenticated mutation requests require a matching Origin. CORS is
  not enabled for third-party browser clients.
- Never return WMS passwords, usernames, connection strings, or raw database
  errors. Role checks do not make returning credentials safe.
- Own-report definitions are private to a verified account and client in the
  application database. Browser storage holds only per-user preferences. Legacy
  local report definitions remain untouched and are not automatically imported.
- Logout uses Clerk's session revocation, returns to the public landing page,
  clears cached queries, and unmounts reporting state when the identity changes.

Warehouse and report permissions are enforced server-side. Set up a client first,
then add its warehouses under **User access → Warehouses**, then configure roles
and assign users to selected warehouses. A client may have multiple warehouses.
Client records include company number, postal address and an optional private
logo; warehouse records include a postal address and contact phone. Logo bytes
are kept in App Storage, while client metadata stores only a private object path.
The logo is served to platform administrators and users approved for that client,
and client/warehouse metadata is included in their reporting session for report
headers. Warehouse names and WMS source codes are application configuration, not
verified imports. Source code and client ownership cannot be changed after
creation; deactivation removes that warehouse from user access. Users without
active assignments stay pending. Actual printable report templates, live report
mappings, schedules, alerts and durable audit history are not implemented.

## WMS credential destination approval

For MySQL 8.4 LTS metadata-only connection testing and its separate credentials, see
[MySQL connection setup](wms-mysql.md). PostgreSQL remains the default.

Connection tests never send credentials to an arbitrary administrator-entered host.
The server must have a valid matching PostgreSQL `WMS_DATABASE_URL`, or a
`WMS_PGPASSWORD` plus all four server-only settings: `WMS_APPROVED_HOST`,
`WMS_APPROVED_PORT`, `WMS_APPROVED_DATABASE`, `WMS_APPROVED_USERNAME`.
Explicit approval settings must be complete; mismatches and missing approval
fail before DNS lookup or creating a PostgreSQL pool. Changing browser fields
does not approve a new endpoint. Owners must make destination changes securely
on the server; do not disable TLS verification to make a test pass.

## WMS network reachability

Network reachability is configured outside WareIQ. A successful connection test
does not create a firewall exception, static egress address, VPN, or private route.

- **WMS firewall allowlisting:** the API runtime must have a fixed outbound IP,
  and the WMS owner must allowlist that source address and PostgreSQL port. Replit
  documents that its Autoscale and Reserved VM deployments do not provide a
  static outbound egress IP. Use a hosting/network setup that supplies fixed
  egress if the WMS requires source-IP allowlisting; do not assume this Repl has
  a stable IP. See [Replit deployment types](https://docs.replit.com/features/publishing/deployment-types)
  and [Replit deployments](https://docs.replit.com/learn/projects-and-artifacts/replit-deployments).
- **Existing VPN/private route:** the application cannot create a VPN or route.
  Replit's published documentation does not describe attaching a deployment to
  a private VPN/VPC route. A private WMS address is reachable only if the runtime
  already has a route provisioned by its hosting/network environment and the
  WMS firewall permits it.
- **Opt-in private destination policy:** public unicast DNS results remain the
  default. To allow a private VPN endpoint, an owner must set server-only
  `WMS_PRIVATE_NETWORK_ENABLED=true` and `WMS_PRIVATE_NETWORK_CIDRS` to a
  comma-separated list of the smallest required RFC1918 IPv4 or IPv6 unique-local
  CIDR ranges, for example `10.40.0.0/16,fd42:1234::/48`. Private ranges are
  rejected unless both settings are valid. The policy rejects public, loopback,
  link-local, reserved, carrier-grade NAT, and other non-private ranges in this
  list; CIDRs broader than the private address blocks are invalid.
- The browser cannot set these controls. The test first checks that host, port,
  database, and username match server approval, resolves the approved hostname
  once, and connects to the selected numeric address. Every DNS result must be
  public unicast or every result must be inside the approved private ranges;
  mixed public/private and any out-of-policy result are rejected. TLS continues
  to verify the original approved hostname, and connection timeout, read-only
  role checks, and sanitized errors remain enforced.

If Replit or the selected hosting environment does not provide the required
source IP or private route, these settings do not create it. Arrange deployment
networking and the customer's firewall/VPN access separately before testing.
