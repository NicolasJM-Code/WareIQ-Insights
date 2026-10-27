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

For just the provider harness's **offline safety** checks:

```sh
pnpm test:auth --project api-authorization artifacts/api-server/tests/provider-harness.test.ts
```

These checks use fake provider clients, synthetic key strings and journals in
temporary directories only. They do not import Clerk, the live provider test or
the app, and need no opt-in or real credentials. They exercise the same lifecycle
helper used by the live command: preflight refusal (including recovery),
ownership/email/ID mismatches, setup and assertion failures, invalid journals,
provider outages, and journal write/unlink failures. This coverage is part of
the ordinary offline suite, not `test:auth:provider`.

The offline suite also checks that the package scripts and Vitest configs keep
the live test out of ordinary discovery. It runs the live test entrypoint in an
isolated subprocess with a fake Clerk module to verify unsafe preflight makes no
provider calls and recovery performs only fixture ownership lookup/deletion,
without importing the app or running token/access checks. The subprocess uses
synthetic environment values and temporary files only; outbound network
connections are disabled for both subprocess runs.

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

The runner keeps JWTs only in memory. Before contacting Clerk to create an
account, it writes a mode-0600, git-ignored intent journal under
`.cache/clerk-provider/<uuid>.json` containing only the generated email and
private run marker. After Clerk returns an ID, the runner atomically replaces
the intent with an ID-scoped record containing the generated user ID, email and
run marker. The journal path is printed, but provider error details, tokens and
credentials are not. A shared lifecycle helper uses `finally` to delete only
the verified generated account (and its sessions) after application setup,
journal update or assertion failures, then removes the journal. A failure is
always nonzero, even if cleanup succeeds.

If a process is killed or Clerk is unavailable during teardown, retain the
journal and rerun **against the same Development instance**:

```sh
CLERK_PROVIDER_TESTS=isolated-development-only \
CLERK_PROVIDER_CLEANUP_MANIFEST=.cache/clerk-provider/<uuid>.json \
pnpm test:auth:provider
```

Recovery mode does not create accounts or run access checks. For an ID-scoped
record, it fetches only that ID and verifies the private run marker and sole
generated email before deletion. For an intent record, it asks Clerk for users
matching only the exact generated email, requires exactly one result, and
verifies that result's private run marker and sole email before saving its ID
and proceeding with ID-scoped cleanup. If no account matches, it removes the
intent journal without changing any account. A provider lookup failure, multiple
matches, or any ownership mismatch fails closed and retains the journal; do not
edit it to target another account. If an account was already deleted, confirm
its absence in the same Development instance before manually removing an
ID-scoped journal. If provider deletion succeeds but journal removal fails, the
runner explicitly reports that the account **was deleted** and tells you to
confirm absence and remove the journal manually, not rerun recovery.

If creation fails before returning an ID (for example, a timed-out response),
the account's existence is unknown. The prewritten intent journal remains
available; explicitly run the recovery command above against the same
Development instance. Recovery checks the exact generated email and private
marker and never creates a replacement account. An abrupt kill after the
provider creates the account but before the ID is journaled is handled the same
way. If exact-email recovery confirms there is no account, it removes the
orphaned intent record so a later, separate test run can proceed. Never
bulk-delete or target customer accounts.

No live provider tests are reachable from `vitest.config.ts`; their separate
config is `vitest.provider.config.ts`. The offline tests import only the shared
`provider-tests/harness.ts`, which has no Clerk/app imports and cannot make
provider calls without an explicitly supplied client. Both suites' TypeScript
is checked by the existing
`pnpm test:auth:typecheck` command without running live checks.
