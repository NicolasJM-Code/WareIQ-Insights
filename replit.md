# WareIQ

Warehouse reporting and product traceability for management, supervisors, and operational users.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm test:auth` — isolated API and UI authorization regressions (no live accounts or WMS)
- `pnpm test:auth:typecheck` — typecheck authorization test code; see `docs/authorization-regression-tests.md`
- `pnpm test:reports` — isolated saved-report persistence and storage-failure regressions; see `docs/saved-report-regression-tests.md`
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

The source requirements are in `attached_assets/Pasted-WMS-Reporting-System-Summary-Specification-Version-1-0-_1793098308089.txt`.

WareIQ reports against an existing operational PostgreSQL WMS database; it must never modify WMS transactions. Do not replace that database with the project's managed database. Live reporting requires the customer's approved reporting views and schema mapping.

The initial application is a frontend demonstration with labeled sample data, not a live WMS integration. Database credentials must not be stored in browser storage or source control. Production connections need server-side secrets, a dedicated SELECT-only account, connection pooling, query timeouts, and administrator access control.

Settings now supports an actual metadata-only connection test via `POST /api/wms/connection/test`. It requires a Clerk user with trusted `publicMetadata.role = "admin"`. Host/port/database/schema/username come from the form; the password comes only from `WMS_PGPASSWORD` or a valid `WMS_DATABASE_URL` matching the form destination and username. Optional `WMS_CA_CERT` supplies a private CA. Verified TLS is mandatory. Tests support public addresses only and reject privileged/write-capable accounts; they do not save a connection or switch reports to live data. Last-success and visible test history are session-only; server logs contain sanitized outcome codes. Approved source mappings are still required for live reports.

Both credential formats are bound to a server-approved host, port, database and username before DNS lookup or opening a connection. A valid server-held PostgreSQL `WMS_DATABASE_URL` provides that binding; standalone `WMS_PGPASSWORD` requires all of `WMS_APPROVED_HOST`, `WMS_APPROVED_PORT`, `WMS_APPROVED_DATABASE` and `WMS_APPROVED_USERNAME`. Explicit destination settings override URL destination approval and must be complete. A URL password must also match its own URL destination. Never let an administrator's browser fields define the destination allowlist. **Why:** a valid-TLS PostgreSQL server controlled by an administrator could otherwise request and capture a server-held password.

Each menu must offer **Reports** (default reports) and **Own reports** (user-created reports using only fields available within that section). Keep custom report field choices scoped to their reporting section.

### User access

- User access management is available at `/user-access` to trusted Clerk platform administrators. Ordinary reporting users are approved by verified login email; they belong to one client, have a role within that client, and may access multiple sites with a primary site.
- Role permissions select individual default reports and separately allow creating own reports within permitted reporting sections. Platform administration is separate from a client's reporting role; granting report-building rights must never grant administration.
- Access setup follows **Client → Warehouses → Roles and user assignments**. A client can have multiple warehouses. Users can access **only explicitly assigned warehouses**, not every warehouse belonging to their client.
- Client records include company number, postal address, and optional private logo uploads; warehouse records include postal address and contact phone. The app makes these details available to authorized report sessions for future print headers; report templates remain separate work.
- Administrators may configure warehouse names and WMS warehouse codes in WareIQ, as requested by the user. This is application configuration, not a WMS import or proof that a source warehouse exists. Live reporting still requires approved source mapping and verification; creating a configuration must not unlock fabricated operational data.
- Warehouse ownership and WMS source identity are immutable after creation, to prevent existing user assignments from silently granting access to a different client's or warehouse's stock. Disable the old warehouse and create a separate configuration when the identity changes.
- Access configuration and private own-report definitions live in the application database (`DATABASE_URL`), never the operational WMS database. The server derives identity, ownership and client scope; a browser-supplied client/site/owner cannot grant access.
- Unassigned or disabled accounts cannot access reporting. Active users see only role-granted report names. Until the WMS is mapped, normal users receive no generated sample rows as client data. Existing sample overviews remain administrator-only demonstrations.
- Previous browser-only own-report definitions are left untouched and not automatically migrated. **Why:** shared browser storage has no trustworthy owner or client identity; assigning it to the next signed-in person could disclose another person's definitions.

Default report names and section assignments come from `attached_assets/Pasted-1-Executive-Dashboard-Warehouse-Performance-Summary-Dai_1793099471452.txt`. The user explicitly requested names only; develop actual default report contents later. Do not attach sample queries, export actions, or field templates to these entries.

## Access administration

Managed Clerk authentication is required for reporting. Roles are explicitly
assigned to verified accounts; new signups have no reporting access. See
`docs/wareiq-access.md` for the first-administrator command and role revocation.
Development role assignment does not grant production access.

Keep new API handlers behind the central guards in
`artifacts/api-server/src/routes/index.ts`. Mount configuration and connection
handlers under `/settings`, `/config`, `/connection`, or `/admin` so they require
Administrator; reporting requires Supervisor or Administrator. Never return WMS
credentials even to administrators.

Each menu must offer **Reports** (default reports) and **Own reports** (user-created reports using only fields available within that section). Keep custom report field choices scoped to their reporting section.

Default report names and section assignments come from `attached_assets/Pasted-1-Executive-Dashboard-Warehouse-Performance-Summary-Dai_1793099471452.txt`. The user explicitly requested names only; develop actual default report contents later. Do not attach sample queries, export actions, or field templates to these entries.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
