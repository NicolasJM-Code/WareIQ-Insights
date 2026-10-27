# Saved-report persistence regressions

Run from the workspace root:

```sh
pnpm test:reports
pnpm test:auth:typecheck
```

`test:reports` is a separate, one-shot Vitest command. It reuses the committed
authorization suite's blank credential environment and runs separate frontend
(jsdom) and API (Node) projects without including these tests in `test:auth`.
No app server is needed. API tests require PostgreSQL's `initdb` and `pg_ctl`
on PATH, run as a non-root user; these are available in the Replit workspace.
Missing binaries fail explicitly rather than skipping persistence coverage.

## Safety and scope

- Frontend tests seed or clear only Vitest's ephemeral jsdom localStorage. They
  do not connect to the preview browser, Clerk, any database or WMS.
- The real store, access/query hooks and generated API transport run against a
  strict fetch stub. Report responses come from a per-test in-memory map.
  Unknown requests fail; no network request can reach customer data.
- A new QueryClient on each reload discards all cached definitions. These
  assertions test client persistence contracts, not database durability.
- Storage faults and mocks are restored after each test; query clients and
  mounted hooks are disposed of to prevent cross-test state and polling.

## Covered behavior

- Create, edit (including column order and optional source removal), duplicate
  and delete; persistence after fresh-cache reloads and live-list refreshes.
- Duplicate names are bounded; original identity and timestamps are not sent.
- HTTP and network failures for every mutation report an error, emit no success
  event and preserve the existing report and its neighbours after reload.
- CRUD and reloads still work with unavailable browser storage, failed reads or
  quota-exceeded writes; no browser writes or removals are attempted.
- Failed report-list requests are explicitly unavailable and can recover.
- Legacy previews preserve raw bytes on repeated reads, including malformed
  JSON, incompatible versions/envelopes, oversized stores and individually
  malformed definitions alongside valid neighbours.
- Blocked legacy reads report an error rather than silently replacing data.
- Unreadable JSON can be removed only after a separate confirmation in the
  import dialog. The cleanup action rechecks the previewed bytes, refuses
  incompatible but readable formats, and reports blocked deletion.

## Difference from the original browser-store plan

Own reports are now server-backed, not stored in localStorage. The legacy browser
store remains read-only during normal use and is **never automatically cleaned
up**. A newly added optional, explicitly confirmed action can discard only
unreadable JSON after comparing it against the previewed value. Incompatible
but readable formats remain intact. This avoids restoring normal browser
writes or inferring legacy ownership from a shared browser.

Server-side persistence/validation and shared-browser import confirmation are
separate from the client store assertions. The existing source-local
`legacy-report-import.test.ts` uses Node's test runner; this Vitest suite does not
collect it or run it under a second runner.

## API persistence regressions

`artifacts/api-server/tests/reports/own-reports-api.test.ts` mounts the real access
router, validators, membership checks and Drizzle queries. Only Clerk identity
is simulated with a verified synthetic address. This is a route-level suite,
not a replacement for the central authentication and same-origin guard suite.

The database helper starts a fresh PostgreSQL cluster in a generated temporary
directory with **no TCP listener**, connects over that directory's Unix socket,
and stops and removes it on completion. It never reads database credentials or
accepts a caller-provided connection or cleanup path. No shared application
database, customer account or WMS connection is used. The minimal SQL fixture
mirrors the access tables needed by these routes, including report timestamps,
the client foreign key and the case-insensitive per-owner/client/section unique
index; keep it aligned with `lib/db/src/schema/access.ts`.

The API and origin suites run in parallel. Each publishes its temporary socket
and PostgreSQL cluster identity to a per-run registry, waits for the other suite,
and checks that the other fixture's sentinel row is neither visible nor
modifiable through its own connection.

Coverage includes:

- Successful create/edit/delete, server-derived ownership, trimmed names,
  preserved creation timestamps, ordered fields and fresh GET readback.
- Validation and duplicate-name errors preserving every stored row, including
  timestamps, the original definition and neighbouring accounts' reports.
- Owner/client-scoped edit and delete, missing reports, forged server-owned
  properties, and loss of section, role, account or sign-in access.
- Real database failures **after** INSERT, UPDATE and DELETE, injected through
  PostgreSQL triggers. Side effects on a second report roll back too; each
  failure returns a sanitized 503, remains readable and supports a later retry.
- Actual unique-index violations after the API's duplicate preflight on create
  and edit, returning explicit 409 errors without retaining partial changes.

The API regressions are explicitly excluded from the authorization-only
command, while remaining included in the API test TypeScript check.
