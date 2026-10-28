# Access-history PostgreSQL integration checks

Run explicitly:

```sh
pnpm test:access-history
pnpm test:access-history:typecheck
```

Requires the PostgreSQL `initdb` and `pg_ctl` binaries on PATH and an unprivileged
OS user. Missing binaries and startup failures fail the suite, rather than
silently skipping it. These checks are deliberately separate from `test:auth`;
no opt-in flag or live database connection string is needed.

## Isolation

The suite creates a uniquely named temporary PostgreSQL cluster, with TCP
disabled and a private Unix socket. Its connections are constructed exclusively
from that generated directory. It accepts no database URL, cleanup path, or
WMS/production override. PostgreSQL subprocesses have an allowlisted environment;
application workers receive only `NODE_ENV=test` and the generated private
`DATABASE_URL`. No Clerk SDK client is instantiated, provider keys are not
inherited, and all account responses are synthetic fixtures.

The history table is rendered from its production Drizzle column definitions.
The fixture intentionally does not recreate unrelated application tables or
performance indexes. Teardown kills remaining workers, shuts down the private
cluster, and removes its temporary directory.

## What the checks establish

Both the Settings API's role-change service and the recovery command run in real,
separate Node processes with the production audit store and lock implementations.
IPC pauses their fake provider call after dispatch. Assertions use a new process
running the normal `accessHistoryPage` query, not a fixture-specific read.

- API-first and command-first contention: PostgreSQL reports a waiting advisory
  lock blocked by a distinct backend. The waiting provider cannot dispatch until
  the holder completes, and both operations then persist confirmed success.
- Real five-second lock timeout: neither provider dispatch nor false success
  occurs; the independently committed intent is retained as `change_not_started`.
- Simulated provider failure after dispatch: the role transaction rolls back,
  while actor, target, previous role and original record ID remain readable as an
  unconfirmed outcome.
- Backend termination during dispatch: current production behavior is a nonzero
  worker exit due to an unhandled PostgreSQL client error. The check deliberately
  does not mask it. The independently committed pending record survives, and no
  success is emitted. Graceful handling of that failure is separate work.
- A real PostgreSQL trigger rejects the final audit UPDATE after a successful
  fake provider response. Both callers reject instead of reporting success;
  pending intent and account IDs remain unchanged.
- SIGKILL after dispatch: fresh application processes return exactly the same
  pending record, including timestamps and account IDs. A later recovery
  operation can acquire the released lock without rewriting the earlier attempt.
- Immediate PostgreSQL shutdown after dispatch: the same private cluster restarts
  without reinitializing its data directory or schema. Its log must confirm
  interrupted startup and automatic recovery. Two fresh application processes
  read back the identical pending record, including actor/target IDs, previous
  role and timestamps. A subsequent operation acquires the released role lock
  without changing that earlier evidence.

These are service/database integration checks, not HTTP authentication or browser
tests. They verify fresh-process read-back and PostgreSQL crash recovery after
immediate server shutdown, not physical database-host failure or power-loss
durability of the underlying storage. They do not infer a historical success
from a matching current provider role.
