# Authorization regression suite

Run from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm test:auth
pnpm test:auth:typecheck
```

`test:auth` runs once and exits nonzero on failure. For a narrower run:

```sh
pnpm test:auth --project api-authorization
pnpm test:auth --project wareiq-authorization
```

## Isolation

These tests require no running app, network access, Clerk account, WMS database,
or secrets. They never create or alter provider users or customer data.
The dedicated Vitest configuration blanks Clerk and WMS credentials and avoids
the preview instrumentation plugins. Clerk's verified-identity and user lookup
boundaries are mocked; a forged request header cannot change the mock identity.
The application database exposes only schema definitions and a throwing query
stub; no live pool is created. Browser fetch calls are mocked while the generated
query hooks, transport, production application guards and own-report store remain real.

The API suite imports the real Express application and router. Test-only
reporting/export and administrator handlers are appended behind the existing
central guards, so guard removal or reordering exposes a successful handler
instead of accidentally passing because a route does not exist. Supertest uses
an isolated, ephemeral local HTTP listener, not the running application.

## Covered risks

- Public health checks versus anonymous 401s on protected and unknown routes.
- Unassigned reporting denial, supervisor reporting allowance and settings 403s,
  administrator allowance across settings/configuration/connection/admin paths.
- Forged identity/role headers, request bodies, unsafe metadata, stale session
  claims, invalid role values, banned and locked accounts.
- Current-role downgrade/revocation and provider outages after successful access;
  denied requests never reach protected handlers and provider details stay private.
- Same-origin mutation enforcement for POST/PUT/PATCH/DELETE, missing or malformed
  origins, hostile hosts, wrong schemes, cross-site fetch metadata and public proxy
  host handling. CORS never offers foreign origins access.
- Membership-based access summaries, unapproved client membership denial and
  current platform-administrator metadata alongside the legacy API guard checks.
- Frontend loading, membership denial, error and retry states; independent
  settings verification; already-visible content locked on failed revalidation.
- Cookie-only no-store requests, session-keyed permissions, periodic/focus
  revalidation policy, sign-out ordering/failure/retry, in-flight cancellation,
  account and same-account session changes, and user-scoped server-report cache isolation.

## Boundaries

These are authorization regressions, not a replacement for verifying Clerk's
cryptographic token validation or the hosting edge. Deployment must overwrite
untrusted forwarded host/protocol headers; application code uses those values
as the public origin behind that trusted edge.

Live WMS integration and administrator role-management screens are separate
work. The active frontend uses `AccessGate` and the session-keyed `use-access`
hook; shared cache cleanup lives in `ClearUserCache`. Do not restore the removed
global-supervisor reporting guard: current reporting approval comes from client
membership. Legacy API endpoints remain behind their central guards while
membership endpoints authorize each operation internally.
