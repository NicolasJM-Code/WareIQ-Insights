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
The synthetic matching key pair has a local pairing attestation; tests also
confirm that changing either key or removing the attestation stops before
provider and journal work.

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
   Clerk's publishable key encodes its frontend API instance URL, but the secret
   key is opaque and cannot be matched to an instance offline. After verifying
   that both keys came from the same isolated Development instance in Clerk,
   generate a fingerprint of the exact pair without printing either key:

   ```sh
   node -e 'const { createHash } = require("node:crypto"); const secret = process.env.CLERK_SECRET_KEY; const publishable = process.env.CLERK_PUBLISHABLE_KEY; if (!secret || !publishable) process.exit(1); process.stdout.write(createHash("sha256").update("wareiq-clerk-provider-key-pair-v1\0").update(secret).update("\0").update(publishable).digest("hex") + "\n")'
   ```

   Save the resulting fingerprint as the workspace secret
   `CLERK_PROVIDER_KEY_PAIR_ATTESTATION`. Recompute and update it whenever either
   Clerk key changes, and only after verifying the new pair in Clerk. This is an
   operator attestation, not an independent discovery of the secret key's
   instance. The runner refuses missing, malformed, or stale fingerprints before
   reading a recovery journal or making provider calls. It also refuses missing
   or live keys, missing opt-in, and `NODE_ENV=production` before importing the
   app or making provider calls.
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

The provider Vitest configuration clears `DATABASE_URL`, `WMS_DATABASE_URL`,
and `WMS_PGPASSWORD` in its test process. Its offline boundary regression starts
the actual provider test entrypoint with synthetic values for all three,
blocks network connections, and verifies the suite sees empty database
settings without constructing a PostgreSQL pool. This check requires no
database credentials and never contacts either database.

## Opt-in browser cookie and frontend revalidation check

```sh
# Requires a working system Chromium binary; install Chromium in the workspace
# if `command -v chromium` returns nothing.
CLERK_BROWSER_TESTS=isolated-development-only \
CLERK_BROWSER_EXECUTABLE="$(command -v chromium)" \
pnpm test:auth:browser
```

This is **separate from** the offline `pnpm test:auth` suite and from the
bearer-provider check. It requires matching `sk_test_…` and `pk_test_…` Clerk
Development keys, network access to Clerk and a working local Chromium. It
refuses Production keys, Production `NODE_ENV`, or an absent opt-in before any
provider calls. Do not set the opt-in globally or add it to routine CI.
Allow about two minutes for a naturally expiring session token and the
frontend's 15-second access recheck. Failures (including a broken Chromium
installation or cleanup) fail the command, not skip it.

The runner serves a minimal React page on a random loopback port with the
production `AuthProvider`, `AccessGate`, `use-access` hook and `access.tsx`
permission components, plus the real Express middleware and Clerk SDK.
Only the database read boundary is replaced with an empty fixture; it
does **not** open the WMS or application database or import report content.
Its only protected children are harmless test markers. It creates one
new `wareiq-browser-<uuid>@example.com` Development account with temporary
administrator metadata. A short-lived single-use Clerk sign-in ticket is
redeemed **inside Chromium**, never injected as a bearer header or copied
into a cookie. The browser reloads, proves a valid `__session` cookie and
same-origin cookie-only request can fetch an active reporting summary and
reach a protected test handler **before** any denial assertion. Other Clerk
development-browser cookies are left to the SDK's real handshake.

The check then prevents SDK refresh traffic without replacing the
cookie or application API. It waits for natural token expiry and confirms
the real `/api/access/me` recheck denies access and both reporting and
administrator markers disappear. A fresh browser sign-in provides a second
positive control; its still-unexpired session is revoked at Clerk and the
next access recheck must lock those markers immediately. Legacy reporting,
settings and own-report requests also deny access; the test-only protected
handler is never reached after invalidation. The compatibility permission
hook must not reuse a stale successful response after a failed refetch.

This covers the Development browser SDK ticket sign-in, browser cookie
handshake, same-origin API transport and frontend revalidation. It **does
not** exercise hosted password/SSO screens, MFA, email delivery, a deployed
edge proxy, or real customer reporting data. A failure to establish the
valid cookie-authenticated control is a failure, not evidence that a bad
session is correctly denied.

The runner writes a private creation-intent journal **before** asking Clerk
to create an account, then records its ID if creation succeeds. The mode-0600
journal under `.cache/clerk-browser/<uuid>.json` contains only the generated
account ID (when known), email and private run marker. If creation's response
is lost, it never blindly retries or deletes an unknown account. It never
logs tickets, JWTs, cookies, credentials, provider error details, browser
storage, screenshots or request bodies. `afterAll` verifies the account ID,
sole generated email and private marker at Clerk before deleting that
account, including on assertion failure. On a process kill, ambiguous
creation or failed cleanup, retain the journal and recover against the
**same** Development instance:

```sh
CLERK_BROWSER_TESTS=isolated-development-only \
CLERK_BROWSER_CLEANUP_MANIFEST=.cache/clerk-browser/<uuid>.json \
pnpm test:auth:browser
```

Recovery creates no account and runs no browser. An intent-only journal uses
an exact-email lookup and deletes **only** if one result also matches the
private run marker and sole generated email; a verified zero-result lookup
clears the journal without deleting an account. Any ambiguous result refuses
deletion and retains the journal. Never bulk-delete or target an existing
account.

The immediate-revocation check exposed that signature verification alone can
accept a previously issued token. A current-session lookup now runs once per
authenticated API request before both membership and legacy access routes.
Inactive, missing, or mismatched sessions return 401; provider lookup outages
fail closed with a sanitized 503. Health checks remain public. Approvals are not
cached: this adds a Clerk API read per authenticated request and deliberately
trades provider availability/latency for prompt revocation.

## Opt-in browser session renewal check

```sh
CLERK_BROWSER_TESTS=isolated-development-only \
CLERK_BROWSER_EXECUTABLE="$(command -v chromium)" \
pnpm test:auth:browser:renewal
```

This is a separate live run, not part of `test:auth:browser`, the ordinary
offline suite, the authorization workflow, or a build. It uses the same
Development-only preflight and private cleanup journal described above and
creates a **new** disposable account for this run. Allow about three minutes
for two genuine short-lived cookie lifetimes plus access polling.

After ticket sign-in and a cookie-authenticated reload control, it keeps the
same reporting document open with Clerk networking enabled. It passively
observes the SDK-written `__session` cookie: the session ID must stay the
same, issuance and expiry must advance, and the new cookie must remain valid
after the first cookie's expiry plus clock-skew allowance. It does not call
`getToken` to trigger renewal, inject cookies, alter clocks, reload the page,
or replace the access API during this observation.

A fresh real `/api/access/me` polling response must still grant reporting,
the reporting and administrator markers must remain visible, and same-origin
cookie-only requests must still reach the harmless protected handler.
The runner then blocks external SDK traffic, proves access still works,
observes at least one blocked session-token renewal attempt, and waits past
the **latest** cookie's expiry. The real hook's next access recheck must lock
both guards and permissions; reporting, settings and own-report APIs must
deny access without reaching protected handlers. A non-renewing SDK therefore
cannot pass only because it correctly locks on expiry.

The database boundary, harmless catalog and sensitive-output suppression are
unchanged. No report data is loaded. The generated account is ownership-checked
and deleted after success or failure, using the same `afterAll` cleanup.
On a process kill or provider cleanup failure, retain the private journal and
use the browser cleanup recovery command above against the same Development
instance. Recovery creates no account and opens no browser.

## Opt-in hosted sign-in screen check

```sh
CLERK_HOSTED_TESTS=isolated-development-only \
CLERK_BROWSER_EXECUTABLE="$(command -v chromium)" \
pnpm test:auth:hosted
```

This separate command requires the same isolated Development setup and Chromium
as the cookie check. `CLERK_BROWSER_TESTS` does **not** enable it. It is never
selected by `pnpm test:auth`, `test:auth:browser`, the authorization workflow, or
a build. Missing opt-in, live/missing keys, Production mode, unsupported login
configuration, screen failures and cleanup failures all fail, never skip.

The isolated page renders the production `SignInPage` and `AuthProvider`.
The journey fills Clerk's hosted email/password component through its visible
form; it does not use a sign-in ticket, SDK sign-in helper, injected cookie,
bearer token, existing account or saved browser session. Only a newly generated
`wareiq-browser-<uuid>+clerk_test@example.com` account is used, with a random
password kept in memory. Clerk's supported Development test-email code `424242`
is entered if the instance requests email verification after password sign-in.
No mailbox, shared password, real email delivery or customer credentials are
used. Password login must be enabled in the isolated Development instance;
the runner does not change its authentication settings.

A successful form submission must unlock both real frontend guards. A reload
must preserve the real cookie session, return an active administrator reporting
summary, and reach a harmless reporting handler behind production middleware.
Only then do fresh, empty browser contexts check failure behavior: blocking the
external sign-in screen and blocking its password handshake must keep both
guards locked and return 401 from reporting, settings and own-report APIs
without reaching the protected handler. The handshake-failure context also
reloads and must remain locked. The application access API and identity provider
are never replaced with synthetic successful responses.

The password is never written into the private cleanup journal or logs.
Browser errors are sanitized; no screenshot, trace, browser storage, request
body or provider error detail is recorded. Teardown attempts ownership-verified
account deletion even after launch, form, assertion or local shutdown failure.
The account's sessions are removed along with the account.

Recovery uses the same private browser journal format (including the generated
test-email suffix) and the same exact ownership checks as the cookie check:

```sh
CLERK_HOSTED_TESTS=isolated-development-only \
CLERK_BROWSER_CLEANUP_MANIFEST=.cache/clerk-browser/<uuid>.json \
pnpm test:auth:hosted
```

Recovery performs no browser launch, account creation or sign-in. Retain the
journal after interruption or ambiguous creation and use the **same**
Development instance; never retry creation blindly or target an existing user.

This is password/test-email coverage of the Clerk-hosted component in the app,
not the separate Account Portal, social SSO, authenticator/TOTP MFA, real email
delivery or a published edge proxy. Those methods are not silently bypassed:
an unexpected required factor fails the positive control. The ordinary offline
suite separately checks hosted opt-in refusal, Development key restrictions,
generated-account/password journal safety, ambiguous creation and discovery
isolation using fake provider and filesystem operations only.

### Provider generated-account cleanup

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
intent journal without changing any account and reports that the exact-email
lookup found no account. Successful deletion of a verified fixture is also
reported explicitly. These messages contain no provider response details,
credentials, or tokens. A provider lookup failure, multiple
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
### Generated-account cleanup (provider check)

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
