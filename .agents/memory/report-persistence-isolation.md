---
name: Report persistence test isolation
description: Why report durability tests use a private temporary PostgreSQL cluster rather than a shared database or SQL mock.
---

Use real PostgreSQL for report persistence regressions, but never the shared development database or WMS. Drizzle wraps PostgreSQL constraint errors in `cause`; inspect `cause.code` and `cause.constraint` in persistence assertions.

**Why:** Client fetch stubs and mocked database builders cannot establish rollback or expression-index behavior. A private Unix-socket-only cluster tests the deployed database engine without risking existing accounts or requiring database secrets.

**How to apply:** Keep persistence checks separate from the credential-free authorization-only command. New database failure tests should use the isolated cluster rather than introducing a connection URL override to a shared database. When asserting a PostgreSQL error from Drizzle, match its wrapped `cause` rather than expecting the driver error at the top level.
