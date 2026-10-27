# Platform access-change history

Settings → Logs → **Platform access history** reads real records from
the application PostgreSQL database (`DATABASE_URL`). No audit operation uses
the operational WMS connection.

## Coverage and privacy

This history covers platform role attempts through `/admin/users/:userId/role`,
including administrator policy denials, stale confirmations, and authenticated
non-administrator/restricted-account denials at the central guards. It does not
cover client reporting memberships, other settings, or exports. Signed Clerk
user-update role observations can capture provider-side evidence, including
updates outside WareIQ, only after each environment's endpoint is configured.
They do not prove that a dashboard edit occurred. The approved
`pnpm --filter @workspace/scripts wareiq:role` command is covered, including
bootstrap grants, revocations, unchanged roles and failed attempts. It starts when this feature is
installed; it does not backfill earlier activity.

Records retain stable actor and target account IDs, the actual old role when
read, requested and confirmed roles, server timestamps, and fixed outcome/reason
codes. They never retain names, email addresses, provider metadata, provider
error payloads, tokens, connection details, or arbitrary request bodies. Invalid
requests and non-administrator denials omit submitted target/role details.
Anonymous requests and requests blocked before verified identity (for example,
cross-origin requests or invalid JSON) are not recorded. Failed identity-provider
lookups are not attributed to an unverified identity.

Only current verified platform administrators can read the endpoint. Responses
are private/no-store. There is no audit edit/delete API. This is a durable
application history, **not** cryptographically tamper-evident storage or a log of
all Clerk activity. Records are retained indefinitely; a retention policy needs
an explicit owner decision before introducing deletion.

## Outcome semantics

An independently committed `unconfirmed` intent is required before acquiring the
role lock or contacting Clerk. If this insert fails, no role change is attempted.
The shared application-database advisory lock serializes Settings and approved
command changes. Settings rechecks its authenticated actor inside it. The
command is a trusted owner recovery override, not an authenticated administrator
request; it can bootstrap an admin and bypass self/last-admin protections.
The old role is saved before dispatching an
update. If that save fails, no provider update is attempted.

- **Confirmed (`succeeded`):** Clerk returned the requested role and the final
  outcome was saved.
- **No change needed (`unchanged`):** the actual old role already matched.
- **Denied (`denied`):** an application policy or request validation blocked the
  attempt.
- **Not attempted (`failed`):** the operation failed before dispatching any
  provider update, such as a read failure or lock timeout.
- **Unconfirmed (`unconfirmed`):** an intent is still pending, the process was
  interrupted, the provider response was uncertain, or final persistence failed.
  This is not proof that an update succeeded or failed. Refresh the current
  account list before retrying.

No database transaction can make a Clerk HTTP update atomic with PostgreSQL.
Consequently, a provider write followed by a database/commit failure returns an
explicit uncertain response and leaves durable evidence, never a false success.
Unknown records are not automatically reconciled: the current role alone cannot
prove which historical attempt caused it.

History uses newest-first keyset pagination, with millisecond timestamps and a
UUID tie-breaker. It refreshes every 30 seconds and on focus; local role attempts
invalidate it whether they succeed or fail.

## Recovery command identity and failures

See `docs/wareiq-access.md` for invocation. `--operator-id` is required and
recorded as `operator:<alias>` in the existing actor field; Settings actors remain
authenticated `user_*` IDs. Use a stable non-personal alias with a separately
controlled owner mapping. This is a terminal operator's attestation, not a
verified Clerk identity, and must never be presented as an authenticated app
administrator. The owner controls who can access the terminal and its credentials.
Neither the email argument nor provider responses are persisted or printed.

Invalid CLI arguments, missing credentials and missing database configuration
fail before an attempt begins. Once validated, the command saves an intent with
an unknown target before any provider lookup or lock. Inside the shared lock it
resolves exactly one verified email match, saves only the safe Clerk target ID,
re-reads that account and records the actual prior role. A target that no longer
matches, is ambiguous, locked, banned or unverified is denied with the fixed
`command_target_ineligible` reason. Failure to save intent, target or prior role
prevents the provider write. An unchanged grant still gets an `unchanged` record.
Provider exceptions, mismatched confirmations, lock commit errors after dispatch,
or final audit-write failures never produce a successful command exit.
The original committed intent remains unconfirmed if completion cannot be saved.
Check current permissions and history before retrying; do not infer that a
nonzero exit means the role did not change.

## Verified external provider evidence

### Provider support and environment readiness

Clerk documents `user.updated` webhooks, delivered by Svix with signed raw
payloads, an event timestamp, instance ID, and a stable `svix-id` across retries.
Delivery is asynchronous, may be duplicated, and is not ordered. An ordinary
user-update contains a user snapshot, **not** a before/after role diff or a
verified dashboard operator identity. Neither public/private metadata nor
`event_attributes` is independently verified actor evidence for this feature.
There is no supported causal identifier here linking a webhook to an interrupted
WareIQ request. We therefore record **observations**, not proven role transitions.

Provider references checked for this implementation:
- https://clerk.com/docs/guides/development/webhooks/overview
- https://clerk.com/docs/reference/backend/verify-webhook
- https://docs.replit.com/features/auth-and-identity/clerk-auth

This project uses Replit-managed Clerk with separate Development and Production
instances; management access was authorized when checked. Replit-managed internal
webhook infrastructure does not establish that this application's evidence
endpoint is subscribed. Readiness inspection found **no** application signing
secret, pinned instance ID, or environment setting in **either Development or
Production**. No delivery was attested or configured by this code change, and no
deployment or provider mutation was made. Until setup is completed, the endpoint
returns 503 and the existing history remains available. This is not a historical
backfill or a claim of complete external coverage.

### Endpoint setup, separately in each environment

An authorized owner must configure an application-specific Clerk webhook
subscription to `user.updated` for the matching Clerk instance. Use the
Replit-managed Clerk dashboard's environment selector; do not reuse signing
secrets or instance IDs across environments, and do not modify Replit's internal
subscriptions. If the managed dashboard does not expose this capability, leave
capture disabled and resolve that prerequisite rather than substituting
unsigned ingestion or current-state polling.

Set these server-side values using Replit Secrets/environment settings:

| Environment | Endpoint path | CLERK_WEBHOOK_ENVIRONMENT | Clerk key mode |
| --- | --- | --- | --- |
| Development | `/api/webhooks/clerk/development` | `development` | `sk_test_` |
| Production | `/api/webhooks/clerk/production` | `production` | `sk_live_` |

- `CLERK_WEBHOOK_INSTANCE_ID`: the exact `ins_*` of that environment's instance.
- `CLERK_WEBHOOK_SIGNING_SECRET`: that endpoint's `whsec_*` signing secret.
- `CLERK_WEBHOOK_ENVIRONMENT`: the exact environment from the table.

Use the actual matching application's reachable origin plus the path above;
obtain the published origin from the deployment settings, not the preview URL.
Apply the application schema before enabling deliveries. Test a delivery and a
replay in each instance, confirm an administrator sees one observation with the
correct environment and provider event time, and confirm unrelated requests
still require their normal session. Never put a secret in a URL, log, or browser.
This setup is intentionally not auto-enabled from shared secrets. Key mode,
configured route and signed payload instance ID must all match. Endpoint
signature verification uses the existing Clerk SDK, including its delivery-time
tolerance. An old *event* may legitimately arrive with a fresh signed *delivery*
timestamp during provider retries/replay.

### Evidence, privacy and ordering

`POST /api/webhooks/clerk/:environment` is mounted before cookie authentication,
same-origin mutation checks, and JSON parsing; **only this exact POST pattern**
uses signature authentication instead. It accepts raw JSON up to 256 KiB.
No ordinary Settings/reporting guard is bypassed. Invalid signatures, stale
delivery timestamps, environment mismatches and instance mismatches never write
evidence. Configuration and database failures return 503 so delivery can retry;
duplicates are acknowledged only after the atomic database insert completes.

Only valid `user.updated` snapshots with an allowlisted platform role
(`admin`, `supervisor`, `unassigned`, or missing/null role meaning unassigned)
are persisted. Unknown role values and unrelated event types are ignored.
Malformed user-update evidence is rejected. Records contain only the stable
target account ID, allowlisted role, event ID, instance ID, routed environment,
provider event timestamp and server receipt timestamp, plus fixed provenance/
outcome/reason codes. Payloads, names, emails, arbitrary metadata, attributes,
signatures and secrets are never stored or logged.

Each observation is a new row with `actorId = external:clerk`, outcome
`observed`, and reason `provider_role_observed`. The UI says **External provider ·
actor unknown** and **Provider role observed**, distinct from authenticated
Settings actors and terminal-attested `operator:*` recovery operators. Old and
requested roles are unknown. The resulting-role column is a role **observed at
the provider event time**, not a current authorization decision or confirmation
of a WareIQ attempt. Webhooks can also reflect Settings/recovery changes;
unknown provenance must not be labelled as a proven external dashboard edit.

The unique `(environment, instance ID, event ID)` database index deduplicates
concurrent delivery, process restarts and signed replays. Late events remain
independent historical evidence: they never overwrite a newer observation,
mutate permissions, invent a previous role or update/reconcile any earlier
attempt. The history remains receipt-time newest-first for stable pagination;
provider event time is displayed separately, so late delivery does not imply
event order. The current account list remains a separate current-state view.
Matching current roles or signed snapshots never prove which earlier request
succeeded. Prefer the approved command for recoveries requiring operator
attestation. Absence of an observation is not proof that no external edit occurred.

## Schema and checks

The Drizzle application schema includes `access_change_history`. Apply the
existing development schema push (`pnpm --filter @workspace/db run push`) after
merging, as already configured in the post-merge setup. No startup DDL or WMS
migration is needed.

Focused isolated checks (no live Clerk or WMS):

```
pnpm exec vitest run --config vitest.config.ts artifacts/api-server/tests/access-history.test.ts
pnpm exec vitest run --config vitest.config.ts scripts/src/role-command.test.ts
pnpm exec vitest run --config vitest.config.ts artifacts/api-server/tests/clerk-events.test.ts artifacts/wareiq/tests/access-history.test.tsx
pnpm exec vitest run --config vitest.reports.config.ts artifacts/api-server/tests/reports/provider-evidence.test.ts
pnpm --filter @workspace/scripts run typecheck
pnpm test:auth:typecheck
```
