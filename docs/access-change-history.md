# Platform access-change history

Settings → Logs → **Platform access history** reads real records from
the application PostgreSQL database (`DATABASE_URL`). No audit operation uses
the operational WMS connection.

## Coverage and privacy

This history covers platform role attempts through `/admin/users/:userId/role`,
including administrator policy denials, stale confirmations, and authenticated
non-administrator/restricted-account denials at the central guards. It does not
cover client reporting memberships, other settings, exports, direct Clerk
dashboard edits, or unapproved role-assignment tools. The approved
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

## External changes: explicitly outside application history

Direct Clerk dashboard edits and other provider tools do not acquire this
application's lock or pass through its audit writer. No webhook is installed by
this feature. The Settings account list is a **current external-state view**:
it reads present Clerk roles, not historical evidence of who changed them.
The access-history coverage notice makes this boundary explicit. An unexplained
current-role difference must not be attributed to an app administrator, assigned
an invented timestamp, backfilled as a successful attempt, or used to resolve an
unconfirmed historical attempt. Use separately available provider-side audit
evidence to investigate external edits. Prefer the approved command for recovery
so future attempts have application evidence.

Any future webhook capture must verify its signature, handle replay/delivery
duplicates and environment routing, retain only allowlisted role data, and label
the actor unknown/external unless independent evidence identifies the operator.
An ordinary user-update payload or metadata value alone is not actor evidence.

## Schema and checks

The Drizzle application schema includes `access_change_history`. Apply the
existing development schema push (`pnpm --filter @workspace/db run push`) after
merging, as already configured in the post-merge setup. No startup DDL or WMS
migration is needed.

Focused isolated checks (no live Clerk or WMS):

```
pnpm exec vitest run --config vitest.config.ts artifacts/api-server/tests/access-history.test.ts
pnpm exec vitest run --config vitest.config.ts scripts/src/role-command.test.ts
pnpm --filter @workspace/scripts run typecheck
pnpm test:auth:typecheck
```
