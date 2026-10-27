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

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
