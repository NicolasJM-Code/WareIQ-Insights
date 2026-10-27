# Saved-report persistence regressions

Run from the workspace root:

```sh
pnpm test:reports
pnpm test:auth:typecheck
```

`test:reports` is a separate, one-shot Vitest command. It reuses the committed
authorization suite's blank credential environment, frontend aliases and jsdom
setup without including these tests in `test:auth`. No app server is needed.

## Safety and scope

- Only Vitest's ephemeral jsdom localStorage is seeded or cleared. Tests do not
  connect to the preview browser, Clerk, any database or WMS.
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
separate from this store-level suite. The existing source-local
`legacy-report-import.test.ts` uses Node's test runner; this Vitest suite does not
collect it or run it under a second runner.
