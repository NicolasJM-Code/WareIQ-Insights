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
confirm that changing either key or removing the attestation stops provider and
journal work in the provider, ticket-browser, and hosted-browser runners.

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

The provider-boundary regression starts both authorization projects in a
subprocess with synthetic `DATABASE_URL`, `WMS_DATABASE_URL`, `WMS_PGPASSWORD`,
and standard PostgreSQL `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGPASSWORD` values. Probe tests confirm the API and WareIQ Vitest workers see
blank values, including the standard PostgreSQL defaults; a temporary setup
observes PostgreSQL `Pool` and `Client` construction across the suite, and the
subprocess blocks outbound network connections. Passing requires the worker
settings to be cleared, no database client to be constructed, and no network
attempt to occur.

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
   pnpm --silent auth:provider:fingerprint
   ```

   Save the resulting fingerprint as the workspace secret
   `CLERK_PROVIDER_KEY_PAIR_ATTESTATION`. Recompute and update it whenever either
   Clerk key changes, and only after verifying the new pair in Clerk. This is an
   operator attestation, not an independent discovery of the secret key's
   instance. The provider, ticket-browser, and hosted-browser runners refuse
   missing, malformed, or stale fingerprints before reading a recovery journal
   or making provider calls. The browser runners also recheck the attestation
   before each fixture account or recovery operation. Each runner also refuses
   missing or live keys, missing opt-in, and `NODE_ENV=production` before
   importing the app or making provider calls.
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
The browser Vitest setup removes `DATABASE_URL`, `WMS_DATABASE_URL`, and
`WMS_PGPASSWORD` before application modules load. Only the database read
boundary is replaced with an empty fixture, and PostgreSQL pool construction is
blocked. The check does **not** use real database credentials, open the WMS or
application database, or import report content. An offline regression supplies
synthetic database settings and blocks network connections while verifying
these protections; it does not need database credentials or Clerk access.
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
creates a **new** disposable account for this run. Allow about seven minutes
for genuine short-lived cookie lifetimes, outage polling, valid-session SDK
recovery and the revoked-session recovery scenario (nine-minute test limit).

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
cannot pass only because it correctly locks on expiry. Another complete access
poll with networking still blocked must leave permissions and both guards
locked, despite the previously successful cached access summary.

The runner then removes only its SDK-network block, keeping the same browser
context, session and reporting document open. It does not sign in again, reload,
inject cookies, request a manual token, or call `getToken` to recover. Passive
cookie observation must prove that the SDK writes a fresh `__session` cookie:
the session ID stays the same, issuance and expiry advance beyond the last
pre-outage cookie, and the cookie is currently unexpired.

The real hook must obtain a new successful `/api/access/me` response granting
active administrator reporting access. The runner observes the browser's real
fetch and briefly delays returning that successful response to the hook. It
returns the original response unchanged only after asserting
that permissions and both protected markers stayed locked throughout recovery.
Thus neither stale cached permissions nor the fresh cookie alone can unlock
reporting before the hook receives fresh server authorization. After delivery,
both markers and permissions must recover and same-origin cookie-only summary
and harmless protected-handler requests must succeed. Failure to renew or
recover within the bounded waits fails the run; it is never skipped.

The same separately enabled command then creates a **fresh browser session**
for that disposable account, proves cookie-authenticated reporting and
administrator access, and blocks SDK networking again. It revokes this exact
session through the real Development backend while the block is in place.
The hook must lock reporting, administrator markers and compatibility
permissions while the original cookie is still unexpired; this cannot pass
merely because a token expired.

The runner removes only the SDK-network block in the same open document,
without signing in again, reloading, injecting cookies or requesting a manual
token. It requires an actual external Clerk client response after restoration,
then waits beyond the pre-outage cookie's expiry plus skew allowance and checks
two further real access polls. Throughout that recovery window, a DOM observer
must never see either protected marker or unlocked compatibility permissions,
and observed real access responses must never grant active status,
administrator access or report IDs. Cookie-only reporting, settings and
own-report requests must return 401 without any further execution of the
harmless protected report handler. The SDK may sign out, but must not select
a replacement session; a final backend lookup must still report the exact
session as revoked. Failure to observe restored SDK connectivity or any
authorization resurrection fails the run with sensitive details suppressed.
This scenario runs only in `test:auth:browser:renewal`, not the offline suite
or the shorter `test:auth:browser` run.

The database boundary, harmless catalog and sensitive-output suppression are
unchanged. No report data is loaded. The generated account is ownership-checked
and deleted after success or failure, using the same `afterAll` cleanup.
On a process kill or provider cleanup failure, retain the private journal and
use the browser cleanup recovery command above against the same Development
instance. Recovery creates no account and opens no browser.

## Opt-in repeated browser renewal outages

```sh
CLERK_BROWSER_TESTS=isolated-development-only \
CLERK_BROWSER_EXECUTABLE="$(command -v chromium)" \
pnpm test:auth:browser:renewal:repeat
```

This longer live scenario is separately selected by
`vitest.browser-renewal-repeat.config.ts` (`CLERK_BROWSER_SCENARIO=renewal-repeat`).
It is **not** part of `test:auth:browser:renewal`, `test:auth:browser`, the offline
suite, the authorization workflow, or a build. Allow about eight minutes;
the scenario has a ten-minute test timeout plus the shared cleanup timeout.
It requires the same explicit opt-in, Development keys, locally verified
key-pair attestation, Chromium and network access as the renewal check above.
Do not enable it globally or in routine offline CI.

One new disposable Development account and one session complete the initial
automatic renewal, then **two full outage/recovery cycles**. After the first
recovery has delivered fresh server authorization and both harmless protected
markers are visible again, SDK networking is interrupted a second time in the
same open document. No navigation is allowed after the initial reload control.
Each cycle takes its own cookie snapshot after blocking networking and verifies
the original session ID; the second snapshot must have a later expiry than the
cookie from the first outage. Each cycle observes a blocked renewal attempt,
waits past that cycle's latest cookie expiry, and requires permissions and both
markers to lock. Another complete access poll must leave them locked, and the
protected APIs must deny access without reaching the harmless report handler.
This specifically prevents permissions renewed after the first recovery from
remaining cached through the second expiry.

Each restoration independently requires advancing issuance and expiry on the
SDK-written cookie for the same session and a fresh, real active `/api/access/me`
response. The original browser fetch response is held before delivery to prove
neither marker nor permissions unlocks early. Only after delivering that original
response may both markers return and cookie-only protected controls succeed.
The runner never signs in again, injects tokens/cookies, manually refreshes,
changes clocks or reloads to recover. Cycle-specific failure phases and success
messages contain no credentials or provider response details.

The existing database isolation, harmless catalog/markers, private ownership-
checked cleanup journal and `afterAll` cleanup apply unchanged; no report data or
real database access is involved. If interrupted, use the existing browser cleanup
recovery command above against the same Development instance before retrying.

## Opt-in two-tab browser renewal outage

```sh
CLERK_BROWSER_TESTS=isolated-development-only \
CLERK_BROWSER_EXECUTABLE="$(command -v chromium)" \
pnpm test:auth:browser:renewal:multitab
```

This separately selected live scenario uses
`vitest.browser-renewal-multitab.config.ts`
(`CLERK_BROWSER_SCENARIO=renewal-multitab`). It is not selected by the ordinary
offline suite, other browser commands, authorization workflow, or builds.
Budget about four minutes; the test timeout is seven minutes plus the shared
60-second cleanup timeout. The explicit opt-in, isolated Development key pair
and local pairing attestation, Chromium and provider networking requirements
are the same as for the other browser checks. Never enable it globally.

One generated account signs in once in a disposable browser context. A second
harmless harness page opens in the same context and proves the same Clerk
session and real cookie-authenticated reporting access. Both documents then
stay open without navigation, reload, focus simulation, token injection,
manual renewal, or another sign-in. The runner explicitly brings each tab to
the foreground for its rechecks, as a user switching tabs would: the production
query hook pauses interval fetches in hidden documents and also revalidates on
focus. No synthetic focus/visibility events or query-policy overrides are used.
SDK networking is interrupted across
the context; the runner snapshots the latest shared cookie, observes a blocked
renewal attempt, waits beyond its natural expiry, and requires each tab's
permissions and reporting/admin markers to lock. Another full poll in each
tab must keep access locked; protected APIs deny access without reaching the
harmless report handler.

After SDK networking returns, passive cookie observation must show advancing
issuance and expiry for the same session. Each document's original browser
fetch must independently obtain a fresh active server authorization response.
Those real responses are held separately before delivery to the production
hook, while continuous observers check that permissions and markers stay
locked. The first tab's response is released, restoring its markers and
cookie-only positive controls. Through a further complete poll in that tab,
the second must remain locked despite the shared refreshed cookie and the
first tab's successful permission cache. Only releasing the second tab's own
fresh authorization response may restore its markers. Both pages must still
have the original session and no post-control navigations.

The scenario reuses the real production provider, hooks, guards and API,
database-environment isolation, blocked PostgreSQL pool construction, separate
Vite cache and harmless report catalog. It loads no report content and saves
no screenshots, traces, storage state, tickets or cookies. Browser errors remain
sanitized. Response holds and observers are disposed on failure, the context
is closed, and shared `afterAll` cleanup ownership-checks and deletes only the
generated account. After interruption or failed cleanup, retain the private
journal and use the existing browser cleanup recovery command against the
same Development instance before retrying.

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

Before hosted test modules load, the runner removes the application and WMS
PostgreSQL settings. The database pool constructor is blocked, and an offline
subprocess check verifies the hosted configuration under synthetic database
settings while blocking outbound networking. This isolation applies to database
access only: a successful hosted sign-in still requires live network access to
Clerk's Development service.

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

If recovery reports that its lock already exists, inspect it before any
cleanup. Use the same development-only opt-in and exact journal path:

```sh
CLERK_PROVIDER_TESTS=isolated-development-only \
CLERK_PROVIDER_CLEANUP_MANIFEST=.cache/clerk-provider/<uuid>.json \
CLERK_PROVIDER_RECOVERY_LOCK_ACTION=inspect \
pnpm test:auth:provider
```

New recovery locks record the process ID, a random lock token, and the Linux
host-boot ID from `/proc/sys/kernel/random/boot_id` when available. Inspection
requires a valid boot ID in both the lock and the current host. A lock from a
different boot is confirmed abandoned without checking its PID, since that PID
could now belong to an unrelated process. For a lock from the current boot,
inspection also checks whether its process is active or absent. Missing or
unverifiable boot evidence, malformed locks, and uncertain process results fail
closed; they never permit automatic removal.

Inspection reports whether the lock is active, confirmed abandoned, or
uncertain. Only when it explicitly reports a confirmed abandoned lock, run the
separate explicit clear action:

```sh
CLERK_PROVIDER_TESTS=isolated-development-only \
CLERK_PROVIDER_CLEANUP_MANIFEST=.cache/clerk-provider/<uuid>.json \
CLERK_PROVIDER_RECOVERY_LOCK_ACTION=clear-abandoned \
pnpm test:auth:provider
```

The clear action checks the owner again immediately before removing the lock.
Active, malformed, unreadable, or otherwise uncertain locks are never removed;
investigate them rather than deleting them manually. These actions do not
contact Clerk, change the journal, or modify an account. After a confirmed
abandoned lock is cleared, rerun the recovery command above.

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
