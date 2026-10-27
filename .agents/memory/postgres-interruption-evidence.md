---
name: PostgreSQL interruption evidence
description: Why role-lock connection-loss tests must distinguish graceful rejection from process crashes.
---

Exercise connection loss while provider work is in flight, not only while a SQL
query is awaiting a result. Do not add fixture-only PostgreSQL error handlers
that silently turn a production process crash into graceful rejection.

**Why:** A checked-out node-postgres client can emit an asynchronous `error`
between queries when its backend is terminated. An operation-level try/catch is
not sufficient to catch that event. Independent audit commits can survive even
when the application cannot finalize the outcome.

**How to apply:** Test both application-process exit and fresh-process history
read-back. Distinguish preserved pending intent from confirmed completion, and
keep graceful connection-loss handling separate from evidence durability claims.
