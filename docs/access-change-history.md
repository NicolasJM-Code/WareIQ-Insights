# Platform access-change history

Settings → Logs → **Platform access history** reads real records from
the application PostgreSQL database (`DATABASE_URL`). No audit operation uses
the operational WMS connection.

## Coverage and privacy

This history covers platform role attempts through `/admin/users/:userId/role`,
including administrator policy denials, stale confirmations, and authenticated
non-administrator/restricted-account denials at the central guards. It does not
cover client reporting memberships, other settings, exports, direct Clerk
dashboard edits, or role-assignment scripts. It starts when this feature is
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
The existing shared application-database advisory lock still serializes changes
and the actor is rechecked inside it. The old role is saved before dispatching an
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

## Schema and checks

The Drizzle application schema includes `access_change_history`. Apply the
existing development schema push (`pnpm --filter @workspace/db run push`) after
merging, as already configured in the post-merge setup. No startup DDL or WMS
migration is needed.

Focused isolated checks (no live Clerk or WMS):

```
pnpm exec vitest run --config vitest.config.ts artifacts/api-server/tests/access-history.test.ts
pnpm test:auth:typecheck
```
