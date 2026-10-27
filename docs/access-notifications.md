# Access-change emails

WareIQ queues transactional email through the project's **Resend** integration.
The sender selected by the owner is `support@chainsoftwaresolutions.com`.
The sender domain must be verified in Resend and the integration must have a
valid sending key. No provider credentials belong in source, browser storage,
API responses, logs, or these instructions.

## Setup status

The connected Resend provider currently rejects requests with **API key is
invalid**. Update its credential on the Integrations page, then confirm
`chainsoftwaresolutions.com` is verified and that the key permits sending from
that domain. The app implementation does not bypass this requirement. Until
corrected, email delivery cannot be confirmed; access changes still succeed.
No real account role was changed and no test email was sent during development.

## Behavior

- Reporting membership approval, reassignment, warehouse-assignment changes,
  disabling and deletion queue notices. Changing an email revokes the old
  recipient and notifies the new one of its role.
- Editing a role's name or report permissions notifies its active members.
- Platform role changes notify only the verified primary Clerk email. They
  explicitly say that client reporting assignments are separate.
- No-op saves, response-loss retries and conflicting platform changes do not
  create extra notices. Inactive membership creation does not claim approval.
- Messages contain the new role, not report data, warehouse codes, credentials,
  client identities, administrator identities, or sign-in tokens.
- Queue insertion uses a savepoint inside membership/role transactions. Only
  committed changes become visible to the delivery worker; insertion failure
  does not roll back the access change. The mutation response distinguishes
  queued, failed-to-queue and unchanged status. “Queued” does not mean delivered.
- Clerk writes are staged in the application DB, then the event ID is merged
  into private Clerk metadata **in the same request as the role change**.
  Confirmation occurs after the provider returns the requested role. A worker
  reconciles a process interruption against that marker under the shared role
  lock before sending. It cancels unconfirmed/superseded staged changes.

## Operation

The existing API service runs the worker; no separate process is required.
Apply the application DB schema through the existing post-merge setup
(`pnpm --filter @workspace/db run push`); never apply it to the operational WMS.

The application DB queue records `pending`, `confirming`, `sent`, `cancelled`,
or `failed`. Each attempt uses the event's stable Resend idempotency key.
Concurrent workers claim rows using PostgreSQL `FOR UPDATE SKIP LOCKED`, and
record the first attempt before network IO. Failed/ambiguous attempts retry
after two minutes. Resend deduplicates for 24 hours: WareIQ stops automatic
retries after 23 hours from first attempt to avoid duplicate mail when the
provider's deduplication window expires. Do not reset the attempt timestamp or
manually resend an ambiguous old event without checking provider delivery.
`sent` means accepted by Resend, not confirmed inbox delivery. The administrator
access page shows aggregate counts for queued, retrying/unconfirmed, accepted,
and terminally failed notices. Retrying counts include an attempt that has not
yet been confirmed and may still be delivered.

If notices are retrying or have failed, administrators should check the Resend
connection and verified sender setup. Provider responses are not shown because
they can contain private information. Logs expose only generic outcome codes,
never provider responses or addresses. The browser receives aggregate counts
only, never recipient addresses, role names, notification IDs, or provider
secrets. Queue records contain recipient addresses and role names and must be
treated as private application data.

Run focused notification checks with:

```
pnpm exec vitest run --config vitest.config.ts artifacts/api-server/tests/access-notifications.test.ts
```
