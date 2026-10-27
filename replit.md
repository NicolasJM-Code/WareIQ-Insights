# WareIQ

Warehouse reporting and product traceability for management, supervisors, and operational users.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
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
