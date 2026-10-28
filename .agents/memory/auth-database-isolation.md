---
name: Authorization database isolation
description: Subprocess regressions for offline authorization suites with local HTTP tests and database guards.
---

Keep database-isolation subprocess tests compatible with authorization suites that use Supertest: allow only loopback HTTP to ephemeral test-server ports, while rejecting external network connections and the synthetic database endpoint. Check both worker-visible environment values and database client construction; network blocking alone cannot prove a client was never created.

**Why:** Blocking every socket breaks Supertest and makes unrelated authorization tests fail. A passing process can also construct a pool without opening a connection, so both checks are needed.

**How to apply:** When testing the ordinary authorization command under synthetic database settings, run both configured projects, add a worker probe per project, instrument PostgreSQL constructors, and preserve only local test-server traffic.
