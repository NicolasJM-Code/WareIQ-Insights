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

Let already-dispatched provider work settle before rejecting on recorded lock
loss; racing it with a disconnection promise does not cancel the provider call.

**Why:** Early rejection leaves a callback able to mutate provider or notification
state after its caller has already finalized the attempt as failed.

**How to apply:** Record asynchronous connection failure immediately, check it
before accepting the callback result or transaction commit, and discard the
failed connection. Keep uncertain outcomes distinct from confirmed success.

Callbacks that finalize evidence through a different database connection must
check lock health themselves before committing that evidence.

**Why:** The outer lock helper can reject correctly but too late: an inner
transaction may already have committed a confirmed outcome after losing the lock.

**How to apply:** Pass a lock-health assertion into callbacks with independent
transactions, and check it after provider awaits and before final evidence writes.
Keep the durable attempt time and provider idempotency key when rolling back an
uncertain delivery.
