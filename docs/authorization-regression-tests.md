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
The application database exposes schema definitions and empty membership reads
(other queries throw); no live pool is created. Browser fetch calls are mocked while the generated
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

## Opt-in Clerk provider integration check

```sh
CLERK_PROVIDER_TESTS=isolated-development-only pnpm test:auth:provider
```

This command is intentionally **not** part of `pnpm test:auth`, the authorization
workflow, or a build. It needs network access and consumes real Clerk development
API calls. Budget roughly 1–2 minutes: expiry is tested by waiting for a genuine
signed session token to expire, including Clerk's clock-skew allowance. No fake
clock, modified expiry claim, mocked identity, or mocked Clerk API is used.
Nonzero exit means a failed check, unsafe setup, provider outage, or cleanup
failure; those conditions are never reported as a skipped/pass result.

### Safe setup

1. Use an isolated development workspace and a Clerk **Development** instance.
   Prefer a dedicated test instance with no customer accounts. For managed Clerk,
   configure Development through the project's Auth tools; do not copy Production
   secrets into the workspace.
2. Supply matching `CLERK_SECRET_KEY` (`sk_test_…`) and
   `CLERK_PUBLISHABLE_KEY` (`pk_test_…`) using workspace secrets. Never put keys,
   cookies, session JWTs, or account passwords in commands, source, or test logs.
   The suite refuses missing/live keys, missing opt-in, and `NODE_ENV=production`
   before importing the app or making provider calls.
3. Do not supply an existing email, account ID, session, token, or published app
   URL. The runner has no remote application target: Supertest hosts the real
   Express app/router on an ephemeral local listener. The app DB is an in-memory
   empty read stub; no application DB pool or WMS connection opens. The keys
   already configured for an isolated development instance are sufficient.
4. Run the command above from the repository root. Never add the opt-in variable
   globally or include this command in the ordinary offline test pipeline.

The fixture always creates a unique `wareiq-provider-<uuid>@example.com` account
with a private run marker and temporary administrator metadata. It never finds,
promotes, signs in, revokes, or deletes an existing account. Clerk marks the
backend-created email verified; no email delivery or shared password is needed.
Sessions are freshly created through Clerk's development session API, and tokens
are signed by the real provider. This is a provider/session integration check,
**not** a test of the hosted password/SSO sign-in UI, MFA, email delivery, or edge
proxy configuration.

### Assertions

- Malformed tokens and a changed signature cannot unlock any protected handler.
- A real, initially accepted token loses access after its natural expiry.
- An initially accepted session is revoked at Clerk; immediate replay of the
  still-unexpired JWT must fail, without waiting for JWT expiry.
- A newly created session works after the preceding session was revoked.
- Bearer token requests have successful controls and denied-token checks.
  Legacy reporting/session endpoints and membership
  own-report routes deny access; the public membership summary either returns
  401 or `signed_out` with no report permissions. Fresh sessions return the real
  administrator reporting summary and reach a test-only handler mounted after
  the production reporting guards. No customer report rows are read.

The live harness uses bearer transport. Browser cookie handshakes (including
Clerk's development-browser and client timestamp cookies) are not simulated by
simply inserting `__session`; those require a separate real-browser check.

The immediate-revocation check exposed that signature verification alone can
accept a previously issued token. A current-session lookup now runs once per
authenticated API request before both membership and legacy access routes.
Inactive, missing, or mismatched sessions return 401; provider lookup outages
fail closed with a sanitized 503. Health checks remain public. Approvals are not
cached: this adds a Clerk API read per authenticated request and deliberately
trades provider availability/latency for prompt revocation.

### Generated-account cleanup

The runner keeps JWTs only in memory. It writes a mode-0600, git-ignored journal
under `.cache/clerk-provider/<uuid>.json` containing only its generated user ID,
email and run marker. The journal path is printed, but provider error details,
tokens and credentials are not. `afterAll` deletes the generated account (and
its sessions) even after a failed assertion, then removes the journal.

If a process is killed or Clerk is unavailable during teardown, retain the
journal and rerun **against the same Development instance**:

```sh
CLERK_PROVIDER_TESTS=isolated-development-only \
CLERK_PROVIDER_CLEANUP_MANIFEST=.cache/clerk-provider/<uuid>.json \
pnpm test:auth:provider
```

Recovery mode does not create accounts or run access checks. It first verifies
that the account's private run marker and sole generated email match the
journal, then deletes only that account and removes the journal. Any mismatch
fails without deletion; do not alter the journal to target another account.
If the account was already deleted, confirm its absence in Development before
manually removing the journal. An abrupt kill between provider creation and
journal persistence can leave an unjournaled account: use Development account
management to locate the exact generated email/private run marker from that run
and delete only that fixture. Never bulk-delete or target customer accounts.

No provider tests are reachable from `vitest.config.ts`; their separate config
is `vitest.provider.config.ts`. Their TypeScript is checked by the existing
`pnpm test:auth:typecheck` command without running live checks.
