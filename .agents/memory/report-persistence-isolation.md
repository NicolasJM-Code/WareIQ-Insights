---
name: Report persistence test isolation
description: Why report durability tests use a private temporary PostgreSQL cluster rather than a shared database or SQL mock.
---

Use real PostgreSQL for report persistence regressions, but never the shared development database or WMS.

**Why:** Client fetch stubs and mocked database builders cannot establish rollback or expression-index behavior. A private Unix-socket-only cluster tests the deployed database engine without risking existing accounts or requiring database secrets.

**How to apply:** Keep persistence checks separate from the credential-free authorization-only command. New database failure tests should use the isolated cluster rather than introducing a connection URL override to a shared database.
